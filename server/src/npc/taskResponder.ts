import { parseJsonReply, type LlmClient } from '../llm';
import type { ActionDraft, KakiCommand, KakiEvent, NpcProfile, Role, Scenario, Task } from '@kaki/shared';

/** What the responder needs from the rest of the NPC process; each is replaced in tests. */
export interface TaskResponderPorts {
  scenario: Scenario;
  llm: Pick<LlmClient, 'complete'>;
  /** True when this attendee is voiced by the AI right now (a person may have taken the seat). */
  plays(attendee: string): boolean;
  /** The attendee says the line aloud; `onDone` runs once they have finished (or the line was dropped). */
  say(attendee: string, text: string, onDone: () => void): void;
  /** Send a command as the phone of `role` would. */
  send(role: Role, command: KakiCommand): void;
  log?(message: string): void;
  /** How long they "read" a draft before approving it; a person would not approve in the same instant. */
  approveDelayMs?: number;
}

/** Default pause before an AI attendee approves a draft. */
export const DEFAULT_APPROVE_DELAY_MS = 6000;

interface Decision {
  accept: boolean;
  line: string;
}

function profileFor(scenario: Scenario, role: Role): { npc: NpcProfile; attendee: string } | undefined {
  const attendee = scenario.attendees.find((candidate) => candidate.role === role);
  const npc = (scenario.npcs ?? []).find((candidate) => candidate.attendee === attendee?.name);
  return attendee === undefined || npc === undefined ? undefined : { npc, attendee: attendee.name };
}

/** The model's accept-or-decline answer, or undefined when it is not usable. */
export function parseDecision(text: string): Decision | undefined {
  let json: unknown;
  try {
    json = parseJsonReply(text);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const { accept, line } = json as { accept?: unknown; line?: unknown };
  if (typeof accept !== 'boolean' || typeof line !== 'string' || line.trim() === '') return undefined;
  return { accept, line: line.trim() };
}

/**
 * An AI attendee has no phone, so this does what the phone would. When a task is dispatched to their role the
 * character decides, in character, whether to take it, says so aloud, and only then sends Accept or Decline,
 * so the shared screen follows their words. After an accepted task's draft is ready they approve it.
 */
export function createTaskResponder(ports: TaskResponderPorts): { handle(event: KakiEvent): void } {
  const { scenario, llm, log } = ports;
  const answered = new Set<string>();
  const approved = new Set<string>();

  async function decide(task: Task, npc: NpcProfile, role: Role): Promise<Decision> {
    const facts = scenario.roles.find((candidate) => candidate.id === role)?.card?.facts ?? [];
    const system = [
      `You are ${npc.attendee} in a work meeting. ${npc.personality}`,
      `What you want: ${npc.agenda}`,
      npc.concerns.length > 0 ? `You worry about: ${npc.concerns.join('; ')}.` : '',
      facts.length > 0 ? `Things you know: ${facts.join(' | ')}` : '',
      'The meeting host has just handed you a task. Decide, as this character, whether to take it.',
      'Take it unless it clearly is not yours or contradicts what you want or worry about.',
      'Reply with one JSON object: {"accept": true or false, "line": what you say aloud, in your own voice}.',
      'The line is one or two short sentences. First a concrete reaction from your own side: what it would take, how long, or what worries you, using only the things you know above and the task details (never invent numbers or facts). Then your decision: you will do it, or you cannot and why in a few words.',
    ]
      .filter((part) => part !== '')
      .join('\n');
    const user = `Task: ${task.title}\nDetails: ${task.context}`;
    try {
      const reply = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        { json: true, temperature: 0.7 },
      );
      const decision = parseDecision(reply);
      if (decision !== undefined) return decision;
      log?.(`could not read ${npc.attendee}'s answer to "${task.title}"; accepting`);
    } catch (error) {
      log?.(`${npc.attendee}'s answer to "${task.title}" failed (${error instanceof Error ? error.message : String(error)}); accepting`);
    }
    return { accept: true, line: "Sure, I'll take that one." };
  }

  async function respond(task: Task, role: Role, who: { npc: NpcProfile; attendee: string }): Promise<void> {
    const decision = await decide(task, who.npc, role);
    log?.(`${who.attendee} ${decision.accept ? 'accepts' : 'declines'} "${task.title}": "${decision.line}"`);
    const command: KakiCommand = decision.accept
      ? { type: 'CLAIM_TASK', taskId: task.id, mode: task.actionKind === undefined ? 'MANUAL' : 'ACTION_AGENT' }
      : { type: 'DECLINE_TASK', taskId: task.id };
    ports.say(who.attendee, decision.line, () => ports.send(role, command));
  }

  return {
    handle(event) {
      if (event.type !== 'TASK_UPDATED') return;
      const { task } = event.payload;
      if (task.status === 'SUGGESTED') answered.delete(task.id); // offered again after a decline
      const role = task.assignee;
      if (role === undefined) return;
      const who = profileFor(scenario, role);
      if (who === undefined || !ports.plays(who.attendee)) return;

      if (task.status === 'DISPATCHED' && !answered.has(task.id)) {
        answered.add(task.id);
        void respond(task, role, who);
      } else if (task.status === 'DRAFT_READY' && task.draft !== undefined && !approved.has(task.id)) {
        approved.add(task.id);
        const draft: ActionDraft = task.draft;
        log?.(`${who.attendee} is reading the draft for "${task.title}"`);
        setTimeout(() => ports.send(role, { type: 'APPROVE_ACTION', taskId: task.id, draft }), ports.approveDelayMs ?? DEFAULT_APPROVE_DELAY_MS).unref();
      }
    },
  };
}
