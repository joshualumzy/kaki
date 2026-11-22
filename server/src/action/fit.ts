import {
  ACTION_KIND_LABELS,
  errorMessage,
  isActionKind,
  type ActionFit,
  type ActionKind,
  type Task,
} from '@kaki/shared';
import type { KakiContext, KakiModule } from '../core/modules';
import type { ChatMessage, LlmClient } from '../services/llm';
import type { WorkspaceTools } from '../workspace/tools';
import { parseDraftObject } from './draft';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Options for the fit check; tests inject a fake model. */
export interface FitModuleOptions {
  llm?: LlmClient;
  timeoutMs?: number;
}

/** The tool kinds a workspace has really connected, in the order they are offered. */
export function connectedKinds(tools: WorkspaceTools | undefined): ActionKind[] {
  if (tools === undefined) return [];
  const kinds: ActionKind[] = [];
  if (tools.mattermost !== undefined) kinds.push('mattermost_post');
  if (tools.gitea !== undefined) kinds.push('gitea_issue');
  if (tools.wiki !== undefined) kinds.push('wiki_page');
  if (tools.email !== undefined) kinds.push('email');
  if (tools.calendar !== undefined) kinds.push('calendar_event');
  return kinds;
}

const TOOL_MEANING: Record<ActionKind, string> = {
  mattermost_post: 'a chat message or announcement to a team channel',
  gitea_issue: 'a bug, feature or work item for the issue tracker',
  wiki_page: 'a page or document update for the team wiki',
  email: 'an email to a person (the draft form asks for an address if it is not known)',
  calendar_event: 'setting up a meeting on the team calendar',
};

/**
 * Obvious credential material must never reach a draft. This is a code backstop, not the fit
 * judgement: it only catches secrets being copied out, and it is logged when it fires.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(pass(word|code|phrase))\s*(is|:|=)/i,
  /\b(api|access|secret|private|signing)\s+(key|token)\b/i,
  /\btoken\s*(is|:|=)/i,
  /\.env\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bcredentials?\b/i,
];

/** True when the to-do asks for or carries credential material. */
export function asksForSecrets(task: Pick<Task, 'title' | 'context'>): boolean {
  const text = `${task.title}\n${task.context}`;
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function fitPrompt(task: Task, connected: readonly ActionKind[]): ChatMessage[] {
  const options = connected.map((kind) => `- "${kind}": ${TOOL_MEANING[kind]}`).join('\n');
  return [
    {
      role: 'system',
      content:
        'You decide whether a connected team tool really fits a to-do, from its meaning. ' +
        'Reply with one JSON object and nothing else: {"kind": <tool kind or "none">, "reason": "<one short sentence>"}. ' +
        `The connected tools are:\n${options}\n` +
        'Choose a tool only when the to-do deliverable is a thing that tool makes: a message or announcement -> mattermost_post; ' +
        'a bug, feature or work item -> gitea_issue; a page or document update -> wiki_page; ' +
        'a task that is literally to email someone -> email; setting up a meeting with someone -> calendar_event. ' +
        'Choose "none" for vague ideas ("think about pricing"), offline or judgement work ("call the supplier", "decide the budget"), ' +
        'or any to-do that is not a deliverable one of these tools makes. Never choose a tool for passwords, tokens, ' +
        'keys, environment files or other credentials. Do not invent a fit; "none" is the common answer.',
    },
    {
      role: 'user',
      content: `To-do: ${task.title}\n\nContext:\n${task.context}`,
    },
  ];
}

/** Parse the model's one JSON object into a fit, or undefined when it is unusable. */
function parseFit(reply: string, connected: readonly ActionKind[]): ActionFit | undefined {
  const value = parseDraftObject(reply);
  if (value === undefined) return undefined;
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (reason === '') return undefined;
  const raw = typeof value.kind === 'string' ? value.kind.trim() : 'none';
  if (raw === 'none' || raw === '') return { status: 'none', reason };
  if (!isActionKind(raw) || !connected.includes(raw)) return undefined;
  return { status: 'ready', kind: raw, reason };
}

/** Judge the fit with the model; a failure is a visible state, never a silent "no fit". */
async function judgeFit(
  task: Task,
  tools: WorkspaceTools | undefined,
  llm: LlmClient | undefined,
  timeoutMs: number,
): Promise<ActionFit> {
  const connected = connectedKinds(tools);
  if (connected.length === 0) {
    return { status: 'none', reason: 'No connected tool can do this.' };
  }
  if (asksForSecrets(task)) {
    console.warn(`kaki action-fit: blocked a to-do that carries credentials: "${task.title}"`);
    return { status: 'none', reason: 'Kaki will not put passwords or tokens in a draft.' };
  }
  if (llm === undefined) {
    return {
      status: 'error',
      reason: 'Kaki could not check which connected tool fits: the model is not configured.',
    };
  }
  try {
    const reply = await llm.complete(fitPrompt(task, connected), {
      json: true,
      signal: AbortSignal.timeout(timeoutMs),
      temperature: 0,
    });
    const fit = parseFit(reply, connected);
    if (fit === undefined) {
      return {
        status: 'error',
        reason: 'Kaki could not check which connected tool fits. The card can still be done by hand.',
      };
    }
    return fit;
  } catch (error) {
    return {
      status: 'error',
      reason: `Kaki could not check which connected tool fits: ${errorMessage(error)}`,
    };
  }
}

/**
 * Checks each to-do once, as soon as it is suggested, and caches the judgement on the task. A
 * connected tool that fits becomes the task's action kind; anything else stays a manual to-do.
 */
export function createFitModule({ llm, timeoutMs = DEFAULT_TIMEOUT_MS }: FitModuleOptions = {}): KakiModule {
  return {
    name: 'action-fit',
    start(ctx: KakiContext) {
      const inFlight = new Set<string>();
      let stopped = false;

      function check(task: Task): void {
        if (stopped) return;
        if (task.purpose !== undefined) return;
        if (task.fit !== undefined) return;
        if (task.status !== 'SUGGESTED' && task.status !== 'DISPATCHED') return;
        if (inFlight.has(task.id)) return;
        inFlight.add(task.id);
        const expected = task.updatedAt;
        void (async () => {
          let tools: WorkspaceTools | undefined;
          try {
            tools = ctx.tools === undefined ? undefined : await ctx.tools();
          } catch (error) {
            ctx.tasks.setActionFit(
              task.id,
              {
                status: 'error',
                reason: `Kaki could not read this workspace's tools: ${errorMessage(error)}`,
              },
              expected,
            );
            return;
          }
          const fit = await judgeFit(task, tools, llm, timeoutMs);
          if (!stopped) ctx.tasks.setActionFit(task.id, fit, expected);
        })()
          .catch((error: unknown) => {
            if (!stopped) console.error('kaki action-fit: the fit check failed', error);
          })
          .finally(() => inFlight.delete(task.id));
      }

      const unsubscribe = ctx.tasks.onChange(check);
      for (const task of ctx.tasks.list()) check(task);
      return () => {
        stopped = true;
        unsubscribe();
      };
    },
  };
}

/** The short label for a fit kind, for logs and tests. */
export function fitLabel(kind: ActionKind | undefined): string {
  return kind === undefined ? 'none' : ACTION_KIND_LABELS[kind];
}
