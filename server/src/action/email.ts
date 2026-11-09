import { randomUUID } from 'node:crypto';
import { createTransport, type Transporter } from 'nodemailer';
import { parseJsonReply, type ChatMessage, type LlmClient } from '../llm';
import type { KakiModule } from '../modules';
import { acceptedDecisionBlock, draftSourceText, unsupportedDraftDetails } from './draftGrounding';
import { ActionError, createActionModule, isObject, messageOf, plainReason, relevantFactsForTask } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;

const CONFIG_MESSAGE =
  'Email is not configured: set MAILPIT_SMTP_HOST, MAILPIT_SMTP_PORT, MAILPIT_URL and EMAIL_FROM';

/** Where email goes: Mailpit's SMTP server, the sender address and the Mailpit web URL. */
export interface EmailSettings {
  smtpHost: string;
  smtpPort: number;
  from: string;
  mailpitUrl: string;
}

/** One message handed to the mail transport. */
export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
}

/** Send one message; tests inject a fake so no socket is opened. */
export type SendMail = (message: EmailMessage) => Promise<unknown>;

/** Options for the email action module; tests inject fakes here. */
export interface EmailModuleOptions {
  llm?: LlmClient;
  email?: EmailSettings;
  sendMail?: SendMail;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

// Simple enough for the assignee's typed-in suggestion: one @, no spaces, text on both sides.
function isAddress(value: string): boolean {
  if (/\s/.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '';
}

// Strictly one JSON object with a non-empty subject and body; a bad address only empties the target.
function parseDraft(reply: string): EmailDraft | undefined {
  let value: unknown;
  try {
    value = parseJsonReply(reply);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const subject = typeof value.subject === 'string' ? value.subject.trim() : '';
  const body = typeof value.body === 'string' ? value.body.trim() : '';
  if (subject === '' || body === '') return undefined;
  const to = typeof value.to === 'string' ? value.to.trim() : '';
  return { to: isAddress(to) ? to : '', subject, body };
}

function recipientsOf(target: string): string[] {
  return target
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => isAddress(part));
}

function baseUrl({ mailpitUrl }: EmailSettings): string {
  return mailpitUrl.replace(/\/+$/, '');
}

/** Create the module that drafts emails and sends them once the assignee approves. */
export function createEmailModule({
  llm,
  email,
  sendMail,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: EmailModuleOptions = {}): KakiModule {
  let transport: Transporter | undefined;

  function requireSettings(): EmailSettings {
    if (email === undefined) throw new ActionError(CONFIG_MESSAGE);
    return email;
  }

  function sendWithSmtp(settings: EmailSettings, message: EmailMessage): Promise<unknown> {
    transport ??= createTransport({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    return transport.sendMail(message);
  }

  async function viewUrl(settings: EmailSettings, messageId: string, signal: AbortSignal): Promise<string> {
    const inbox = baseUrl(settings);
    try {
      const id = messageId.slice(1, -1);
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetchImpl(`${inbox}/api/v1/search?query=message-id:${id}`, {
        method: 'GET',
        signal: AbortSignal.any([timeout, signal]),
      });
      if (!response.ok) return inbox;
      const body: unknown = await response.json();
      if (isObject(body) && Array.isArray(body.messages)) {
        const [first] = body.messages as unknown[];
        if (isObject(first) && typeof first.ID === 'string' && first.ID.trim() !== '') {
          return `${inbox}/view/${first.ID}`;
        }
      }
    } catch {
      // The mail is already sent, so a failed lookup must not fail the action and tempt a double send.
    }
    return inbox;
  }

  const actionModule = createActionModule({
    name: 'action-email',
    kind: 'email',
    async draft(task, signal, scenario) {
      requireSettings();
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the email cannot be drafted');
      }

      const roleId = task.assignee ?? task.suggestedAssignee;
      const role = scenario.roles.find((candidate) => candidate.id === roleId);
      const allFacts = [
        ...(role?.card?.facts ?? []),
        ...scenario.roles.flatMap((r) => (r.id === roleId ? [] : r.card?.facts ?? [])),
      ];
      const knownFacts = relevantFactsForTask(task, allFacts, true);
      const senderLine = role !== undefined ? `\nSender role: ${role.label}` : '';
      const factsBlock =
        knownFacts.length > 0 ? `\n\nKnown facts from the team:\n- ${knownFacts.join('\n- ')}` : '';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a short, polite email. Reply with one JSON object and nothing else: ' +
            '{"to": "...", "subject": "...", "body": "..."}. Write the body as plain text and keep it short. ' +
            'For "to", look up the matching recipient email address in the Known facts below when one is listed for the person or partner mentioned in the task or context; if the email is to an internal team or colleague with no listed address, use a sensible address at @example.com (such as team@example.com or dev@example.com).' +
            ' Use only what is in the task, its context, and any known facts below that are directly about the same topic as the task (ignore known facts about unrelated issues or other agenda items). When an Accepted decision is given, keep its time of day, who owns or enforces it, and how it will be measured; do not leave out a detail it gives. Do not invent steps, versions, names, dates, numbers or placeholders such as [Insert ...]; if something is not given, leave it out. If the Context gives a time of day without AM or PM, keep it exactly as written; never choose AM or PM yourself. Never write "effective immediately" or another start date unless the Context explicitly states it. Keep the words of the task title in the title.',
        },
        {
          role: 'user',
          content: `Task: ${task.title}${senderLine}\n\nContext:\n${task.context}${factsBlock}${acceptedDecisionBlock(task.decisionSource)}`,
        },
      ];

      let reply: string;
      try {
        reply = await llm.complete(messages, { json: true, signal });
      } catch (error) {
        throw new ActionError(`Could not draft the email: ${messageOf(error)}`);
      }

      const draft = parseDraft(reply);
      if (draft === undefined) {
        throw new ActionError('The LLM did not return usable JSON with a subject and body');
      }
      const unsupported = unsupportedDraftDetails(
        `${draft.subject}\n${draft.body}`,
        draftSourceText(task, knownFacts),
      );
      if (unsupported.length > 0) {
        throw new ActionError(
          `The draft adds details the task does not support: ${unsupported.join('; ')}. Edit the task or retry.`,
        );
      }
      return { target: draft.to, subject: draft.subject, body: draft.body };
    },
    async run(task, signal) {
      const settings = requireSettings();
      const draft = task.draft;
      if (draft === undefined) throw new ActionError('The task has no draft to send');

      const recipients = recipientsOf(draft.target);
      if (recipients.length === 0) {
        throw new ActionError('Add a valid recipient email address before sending');
      }

      const messageId = `<kaki-${randomUUID()}@kaki.local>`;
      const send = sendMail ?? ((message: EmailMessage) => sendWithSmtp(settings, message));
      try {
        await send({
          from: settings.from,
          to: recipients,
          subject: draft.subject,
          text: draft.body,
          messageId,
        });
      } catch (error) {
        throw new ActionError(`could not send the email: ${plainReason(error, 'The mail server')}`);
      }

      return viewUrl(settings, messageId, signal);
    },
  });

  return {
    name: actionModule.name,
    start(ctx) {
      const stop = actionModule.start(ctx);
      return () => {
        stop?.();
        transport?.close();
        transport = undefined;
      };
    },
  };
}
