import { randomUUID } from 'node:crypto';
import { errorMessage, isObject } from '@kaki/shared';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { ChatMessage, LlmClient } from '../services/llm';
import type { KakiModule } from '../core/modules';
import type { WorkspaceTools } from '../workspace/tools';
import { draftString, parseDraftObject } from './draft';
import { acceptedDecisionBlock, draftSourceText, memorySourceBlock, unsupportedDraftDetails } from './draftGrounding';
import { DEFAULT_PROBE_TIMEOUT_MS, probeFailed, probeFetch, probeOk, responseProblem, type ToolProbeResult } from './probe';
import { ActionError, createActionModule, plainReason, factsForTask } from './runner';

const DEFAULT_TIMEOUT_MS = 10_000;

const CONFIG_MESSAGE = 'Email is not connected for this workspace.';

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

/** The part of a mail transport the probe needs; tests inject a fake so no socket is opened. */
export interface EmailTransport {
  verify(): Promise<true>;
  close?(): void;
}

/** Build a transport for the probe; tests inject a fake here. */
export type EmailTransportFactory = (settings: EmailSettings, timeoutMs: number) => EmailTransport;

/** Options for the read-only email probe; tests inject fakes here. */
interface EmailProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  createTransport?: EmailTransportFactory;
}

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

function cleanRecipientPart(raw: string): string {
  const trimmed = raw.trim();
  const angleMatch = /<([^<>]+)>/.exec(trimmed);
  return (angleMatch?.[1] ?? trimmed).trim();
}

function recipientsOf(target: string): string[] {
  return target
    .split(/[,;]/)
    .map(cleanRecipientPart)
    .filter((part) => isAddress(part));
}

// Strictly one JSON object with a non-empty subject and body; a bad address only empties the target.
function parseDraft(reply: string): EmailDraft | undefined {
  const value = parseDraftObject(reply);
  if (value === undefined) return undefined;
  const subject = draftString(value, 'subject').trim();
  const body = draftString(value, 'body').trim();
  if (subject === '' || body === '') return undefined;
  const to = draftString(value, 'to').trim();
  const validTo = recipientsOf(to);
  return { to: validTo.join(', '), subject, body };
}

function baseUrl({ mailpitUrl }: EmailSettings): string {
  return mailpitUrl.replace(/\/+$/, '');
}

/** The SMTP options both the send path and the probe use, so a probe proves the real path works. */
function smtpOptions(settings: EmailSettings, timeoutMs: number): SMTPTransport.Options {
  return {
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
}

const SENDING_SIDE = "The mail server's sending side";

const SMTP_AUTH_CODES = new Set([530, 534, 535]);

function isSmtpAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { code, responseCode } = error as Error & { code?: unknown; responseCode?: unknown };
  return code === 'EAUTH' || (typeof responseCode === 'number' && SMTP_AUTH_CODES.has(responseCode));
}

class ProbeTimeout extends Error {}

async function probeMailbox(
  settings: EmailSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ToolProbeResult> {
  const outcome = await probeFetch(
    fetchImpl,
    `${baseUrl(settings)}/api/v1/messages?limit=1`,
    { method: 'GET' },
    'The mail server',
    timeoutMs,
  );
  if (!outcome.ok) return outcome.result;
  const response = outcome.response;
  if (!response.ok) return responseProblem(response, 'The mail server');

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return probeFailed('unexpected response', 'The mail server answered with something that is not JSON.');
  }
  if (!isObject(body) || !Array.isArray(body.messages)) {
    return probeFailed('unexpected response', 'The mail server answered without a message list.');
  }
  return probeOk('The mailbox can be read.');
}

async function probeSendingSide(
  settings: EmailSettings,
  timeoutMs: number,
  makeTransport: EmailTransportFactory,
): Promise<ToolProbeResult> {
  const transport = makeTransport(settings, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transport.verify(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
      }),
    ]);
    return probeOk('Mail can be sent.');
  } catch (error) {
    if (error instanceof ProbeTimeout) {
      return probeFailed(
        'timeout',
        `${SENDING_SIDE} did not answer within ${timeoutMs} ms. Check that it is running and try again.`,
      );
    }
    if (isSmtpAuthError(error)) {
      return probeFailed('auth failed', `${SENDING_SIDE} rejected the saved credentials.`);
    }
    return probeFailed(
      'unreachable',
      `${SENDING_SIDE} could not be reached. Check that its SMTP host and port are correct, then press Retry. (${errorMessage(error)})`,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      transport.close?.();
    } catch {
      // The check is already finished; a failed close must not change its result.
    }
  }
}

/** Checks both the mailbox read side and the SMTP sending side of the mail server. */
export async function probeEmail(
  settings: EmailSettings,
  {
    fetchImpl = fetch,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    createTransport: makeTransport = (target, timeout) =>
      createTransport(smtpOptions(target, timeout)),
  }: EmailProbeOptions = {},
): Promise<ToolProbeResult> {
  const mailbox = await probeMailbox(settings, fetchImpl, timeoutMs);
  if (!mailbox.ok) return mailbox;

  const sending = await probeSendingSide(settings, timeoutMs, makeTransport);
  if (!sending.ok) return sending;

  return probeOk('The mail server answered: the mailbox can be read and mail can be sent.');
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

  function settingsFrom(tools: WorkspaceTools | undefined): EmailSettings | undefined {
    return email ?? tools?.email;
  }

  function requireSettings(tools: WorkspaceTools | undefined): EmailSettings {
    const settings = settingsFrom(tools);
    if (settings === undefined) throw new ActionError(CONFIG_MESSAGE);
    return settings;
  }

  function sendWithSmtp(settings: EmailSettings, message: EmailMessage): Promise<unknown> {
    transport ??= createTransport(smtpOptions(settings, timeoutMs));
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
    unconfiguredReason: (tools) => (settingsFrom(tools) === undefined ? CONFIG_MESSAGE : undefined),
    async draft(task, signal, scenario, _visitorName, memory, tools) {
      requireSettings(tools);
      if (llm === undefined) {
        throw new ActionError('The LLM is not configured, so the email cannot be drafted');
      }

      const roleId = task.assignee ?? task.suggestedAssignee;
      const role = scenario.roles.find((candidate) => candidate.id === roleId);
      const knownFacts = factsForTask(task, scenario, roleId, true);
      const senderLine = role !== undefined ? `\nSender role: ${role.label}` : '';
      const factsBlock =
        knownFacts.length > 0 ? `\n\nKnown facts from the team:\n- ${knownFacts.join('\n- ')}` : '';

      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            'You turn a team task into a short, polite email. Reply with one JSON object and nothing else: ' +
            '{"to": "...", "subject": "...", "body": "..."}. Write the body as plain text and keep it short. ' +
            'For "to", look up the matching recipient email address in the Known facts below when one is listed for the person or partner mentioned in the task or context; if no email address is listed for the recipient (including customers, officers, suppliers, or internal colleagues), always provide a sensible address at @example.com (such as customer@example.com, agency@example.com, supplier@example.com, or team@example.com) and never leave "to" empty.' +
            ' Use only what is in the task, its context, and any known facts below that are directly about the same topic as the task (ignore known facts about unrelated issues or other agenda items). When an Accepted decision is given, keep its time of day, who owns or enforces it, and how it will be measured; do not leave out a detail it gives. Do not invent steps, versions, names, dates, numbers or placeholders such as [Insert ...]; if something is not given, leave it out. If the Context gives a time of day without AM or PM, keep it exactly as written; never choose AM or PM yourself. Never write "effective immediately" or another start date unless the Context explicitly states it. Keep the words of the task title in the title.',
        },
        {
          role: 'user',
          content: `Task: ${task.title}${senderLine}\n\nContext:\n${task.context}${factsBlock}${acceptedDecisionBlock(task.decisionSource)}${memorySourceBlock(memory)}`,
        },
      ];

      let reply: string;
      try {
        reply = await llm.complete(messages, { json: true, signal });
      } catch (error) {
        throw new ActionError(`Could not draft the email: ${errorMessage(error)}`);
      }

      const draft = parseDraft(reply);
      if (draft === undefined) {
        throw new ActionError('The LLM did not return usable JSON with a subject and body');
      }
      const unsupported = unsupportedDraftDetails(
        `${draft.subject}\n${draft.body}`,
        draftSourceText(task, knownFacts, memory),
      );
      if (unsupported.length > 0) {
        throw new ActionError(
          `The draft adds details the task does not support: ${unsupported.join('; ')}. Edit the task or retry.`,
        );
      }
      return { target: draft.to, subject: draft.subject, body: draft.body };
    },
    async run(task, signal, _scenario, _visitorName, tools) {
      const settings = requireSettings(tools);
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
