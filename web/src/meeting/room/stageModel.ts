import {
  isKakiListener,
  type KakiEvent,
  type Scenario,
  type Task,
} from '@kaki/shared';

/** A retry of the same browser line carries the same id, so the server writes it once. */
export function newClientLineId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * What a colleague stands for, from the scenario's own short stance for their seat. A scenario
 * without one shows nothing: an owner-written meeting never inherits a pack's role copy.
 */
export function colleagueStance(scenario: Scenario, attendeeName: string): string | undefined {
  const roleId = scenario.attendees.find((attendee) => attendee.name === attendeeName)?.role;
  const stance = roleId === undefined ? undefined : scenario.roles.find((role) => role.id === roleId)?.stance?.trim();
  return stance === undefined || stance === '' ? undefined : stance;
}

/** The two quick replies a person may tap on this topic: their open questions, then colleague trade-offs. */
export function starterChipsFromAgendaItem(
  item: Scenario['agenda'][number] | undefined,
  viewerSeatName: string | undefined,
  openQuestions: ReadonlyArray<{ text: string; forRole?: string }>,
  hostName?: string,
): readonly string[] {
  const chips: string[] = [];
  for (const q of openQuestions) {
    if (q.text.trim().length > 0 && !chips.includes(q.text.trim())) {
      chips.push(q.text.trim());
    }
  }
  const tradeOffs = item?.discussion?.tradeOffs ?? [];
  for (const to of tradeOffs) {
    if (viewerSeatName !== undefined && to.attendee.toLowerCase() === viewerSeatName.toLowerCase()) continue;
    const question = to.question.trim();
    const addressed = question.toLowerCase().startsWith(to.attendee.toLowerCase())
      ? question
      : `${to.attendee}, ${question[0]!.toLowerCase()}${question.slice(1)}`;
    if (!chips.includes(addressed)) chips.push(addressed);
  }
  const host = hostName?.trim();
  const addressed = (text: string): string => (host === undefined || host === '' ? text : `${host}, ${text}`);
  const fallback = [
    addressed("could you summarize the two main options we're choosing between right now?"),
    addressed("what's still open on this one?"),
  ];
  for (const fb of fallback) {
    if (!chips.includes(fb)) chips.push(fb);
  }
  return chips.slice(0, 2);
}

/** A colleague's reaction emoji if one landed in the last four seconds, with its tone for styling. */
export function reactionForColleague(
  attendeeName: string,
  events: readonly (KakiEvent & { receivedAt?: number })[],
  now: number,
): { emoji: string; label: string; tone: 'catch' | 'lock' | 'agree' } | undefined {
  const latest = [...events].reverse().find((event) => event.type === 'COLLEAGUE_REACTION' &&
    event.payload.who === attendeeName && event.receivedAt !== undefined &&
    now - event.receivedAt < 4000);
  if (latest?.type !== 'COLLEAGUE_REACTION') return undefined;
  const tone = latest.payload.emoji === '🙌' ? 'lock' : latest.payload.emoji === '👍' ? 'agree' : 'catch';
  return { emoji: latest.payload.emoji, label: 'Reacted', tone };
}

/**
 * Put a speaking participant's track first so a paginated phone stage shows whoever is talking.
 * The order is unchanged when the speaker is already on the visible page.
 */
export function tracksWithSpeakerFirst<T extends { participant: { identity: string } }>(
  tracks: readonly T[],
  speaker: string | undefined,
): T[] {
  if (speaker === undefined) return [...tracks];
  const index = tracks.findIndex((track) => track.participant.identity === speaker);
  if (index <= 0) return [...tracks];
  const reordered = [...tracks];
  const [speaking] = reordered.splice(index, 1);
  if (speaking !== undefined) reordered.unshift(speaking);
  return reordered;
}

/**
 * The visitor's open task the stage banner should announce: their task on the current topic when there is
 * one, otherwise the most recently updated open task. Map order alone would keep announcing topic 1's draft
 * after the meeting has moved on.
 */
export function activeStageTaskFor(
  tasks: Iterable<Task>,
  role: string,
  currentAgendaTitle: string | undefined,
): Task | undefined {
  const openTasks = [...tasks].filter(
    (t) =>
      (t.assignee ?? t.suggestedAssignee) === role &&
      (t.status === 'DISPATCHED' || t.status === 'DRAFT_READY'),
  );
  if (currentAgendaTitle !== undefined) {
    const onCurrentTopic = openTasks.find((t) => t.agendaItemTitle === currentAgendaTitle);
    if (onCurrentTopic !== undefined) return onCurrentTopic;
  }
  return openTasks.reduce<Task | undefined>(
    (latest, task) => (latest === undefined || task.updatedAt >= latest.updatedAt ? task : latest),
    undefined,
  );
}

/**
 * The dock section that shows a task to a seat: its own "Needs you now" cards, or the shared Action
 * board. The panel filter and the stage pill both use this so the two cannot drift apart.
 */
export function taskDockSection(
  task: Task,
  role: string | undefined,
  context: { meetingEnded: boolean; currentAgendaTitle: string | undefined },
): 'needs-you-now' | 'action-board' {
  if (role === undefined || (task.assignee ?? task.suggestedAssignee) !== role) return 'action-board';
  switch (task.status) {
    case 'DISPATCHED':
    case 'DRAFT_READY':
    case 'FAILED':
    case 'COMPLETED':
    case 'CLAIMED':
    case 'RUNNING':
      return 'needs-you-now';
    case 'SYNCED':
      if (task.artifactUrl === undefined) return 'action-board';
      if (context.meetingEnded) return 'action-board';
      if (
        context.currentAgendaTitle !== undefined &&
        task.agendaItemTitle !== undefined &&
        task.agendaItemTitle !== context.currentAgendaTitle
      ) {
        return 'action-board';
      }
      return 'needs-you-now';
    default:
      return 'action-board';
  }
}

/**
 * The tracks the stage shows: never the runner's technical listener, and only AI attendees in this
 * meeting's cast. People are never filtered by metadata: a camera-off placeholder must still show
 * its human tile.
 */
export function visibleStageTracks<T extends { participant: { identity: string; metadata?: string } }>(
  tracks: readonly T[],
  scenario: Pick<Scenario, 'npcs'>,
): T[] {
  const aiNames = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
  return tracks.filter((track) => {
    const person = track.participant;
    if (isKakiListener(person.identity)) return false;
    return person.metadata?.trim() !== 'AI attendee' || aiNames.has(person.identity);
  });
}
