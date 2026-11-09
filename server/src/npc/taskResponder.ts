import { parseJsonReply, type LlmClient } from '../llm';
import { isAssignmentEvidence, type ActionDraft, type KakiCommand, type KakiEvent, type NpcProfile, type Role, type Scenario, type Task } from '@kaki/shared';
import { isHypotheticalProposal, isSelfVolunteerCommitment } from '../host/notetaker';

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
  /** When true, still claim and draft tasks, but never auto-approve or retry so nothing is sent. */
  draftOnly?: boolean;
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

function baseSpeakerName(speaker: string): string {
  return speaker.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
}

/**
 * True only when the recorded evidence is the current assignee's own grounded commitment to exactly this task.
 * A changed title, context or action is a different task, and a request, delegation, question or hypothetical
 * (or evidence about someone else) never grants acceptance authority.
 */
function isTrustedCommitment(task: Task, attendee: string, scenario: Scenario): boolean {
  const evidence = task.assignmentEvidence;
  if (evidence === undefined || !isAssignmentEvidence(evidence)) return false;
  if (baseSpeakerName(evidence.speaker) !== baseSpeakerName(attendee)) return false;
  if (!isSelfVolunteerCommitment(evidence.quote, scenario, evidence.speaker)) return false;
  if (isHypotheticalProposal(evidence.quote)) return false;
  const { scope } = evidence;
  return scope.title === task.title && scope.context === task.context && scope.actionKind === task.actionKind;
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
  const retried = new Set<string>();

  async function decide(task: Task, npc: NpcProfile, role: Role): Promise<Decision> {
    const facts = scenario.roles.find((candidate) => candidate.id === role)?.card?.facts ?? [];
    const system = [
      `You are ${npc.attendee} in a work meeting. ${npc.personality}`,
      `What you want: ${npc.agenda}`,
      npc.concerns.length > 0 ? `You worry about: ${npc.concerns.join('; ')}.` : '',
      facts.length > 0 ? `Things you know: ${facts.join(' | ')}` : '',
      'The meeting host has just handed you a task. Decide, as this character, whether to take it.',
      'Accept it (`"accept": true`) if it is a follow-up ticket, post, email or note for your role or something your role talked about. Only decline (`"accept": false`) if the task clearly belongs to a completely different role.',
      'Reply with one JSON object: {"accept": true or false, "line": what you say aloud, in your own voice}.',
      'When accepting (`"accept": true`), the line MUST clearly say you will take or do the task (for example "Sure, I\'ll get that filed today so we lock in the one-per-person limit." or "On it, I\'ll post that update in the team channel right after the call."), plus one brief concrete detail from the things you know above (never invent numbers, facts, drafts, or prerequisites, and never sound like you are arguing with or refusing a task you are accepting). Statements only: never ask a question. Plain everyday words, as you would say it to a colleague, no jargon or office-speak.',
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
    const fallbackLines = [
      "Sure, I'll take that one.",
      "On it, I'll sort that out.",
      "No problem, leave that with me.",
      "Steady, I can handle that.",
    ];
    const line = fallbackLines[Math.abs(task.title.length) % fallbackLines.length]!;
    return { accept: true, line };
  }

  function claimCommand(task: Task): KakiCommand {
    return { type: 'CLAIM_TASK', taskId: task.id, mode: task.actionKind === undefined ? 'MANUAL' : 'ACTION_AGENT' };
  }

  async function respond(task: Task, role: Role, who: { npc: NpcProfile; attendee: string }): Promise<void> {
    // The assignee already volunteered for this exact task in the transcript, so hold them to their own words
    // instead of letting the model talk them out of it. Any change to the work, or any doubt about the evidence,
    // falls back to the ordinary in-character decision.
    if (isTrustedCommitment(task, who.attendee, scenario)) {
      const line = "I said I'd take that on, so I'll do it.";
      log?.(`${who.attendee} keeps their own commitment to "${task.title}": "${line}"`);
      ports.say(who.attendee, line, () => ports.send(role, claimCommand(task)));
      return;
    }
    const decision = await decide(task, who.npc, role);
    log?.(`${who.attendee} ${decision.accept ? 'accepts' : 'declines'} "${task.title}": "${decision.line}"`);
    const command: KakiCommand = decision.accept ? claimCommand(task) : { type: 'DECLINE_TASK', taskId: task.id };
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
      } else if (!ports.draftOnly && task.status === 'DRAFT_READY' && task.draft !== undefined && !approved.has(task.id)) {
        approved.add(task.id);
        const draft: ActionDraft = task.draft;
        log?.(`${who.attendee} is reading the draft for "${task.title}"`);
        setTimeout(() => ports.send(role, { type: 'APPROVE_ACTION', taskId: task.id, draft }), ports.approveDelayMs ?? DEFAULT_APPROVE_DELAY_MS).unref();
      } else if (!ports.draftOnly && task.status === 'FAILED' && !retried.has(task.id)) {
        retried.add(task.id);
        log?.(`${who.attendee} is retrying failed task "${task.title}"`);
        setTimeout(
          () =>
            ports.send(
              role,
              task.draft === undefined
                ? { type: 'RETRY_ACTION', taskId: task.id }
                : { type: 'RETRY_ACTION', taskId: task.id, draft: task.draft },
            ),
          3000,
        ).unref();
      }
    },
  };
}
