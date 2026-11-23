import type { AgendaItem, Attendee, NpcProfile, Scenario, ScenarioRole } from './scenarioTypes';

/** LiveKit data topic on which the browser sends the words its speech recognition heard. */
export const STT_TOPIC = 'kaki.stt';

/** LiveKit data topic on which the AI attendees say what they are doing (thinking, speaking, ...). */
export const NPC_STATE_TOPIC = 'kaki.npc-state';

/** LiveKit data topic on which the runner reports each person's microphone and recognition state. */
export const SPEECH_STATUS_TOPIC = 'kaki.speech-status';

/** LiveKit data topic for the browser's old control messages; only Start remains. */
export const CONTROL_TOPIC = 'kaki.control';

/**
 * LiveKit data topic for the dev-only fake speech recogniser (`KAKI_FAKE_STT=1`). Only the LiveKit
 * server can send on it (a browser's message has a sender and is refused): scripted runs use it to
 * "say" a line as a person, and the runner treats it exactly like a line its recogniser heard.
 */
export const FAKE_STT_TOPIC = 'kaki.fake-stt';

/** What a script sends on {@link FAKE_STT_TOPIC}: the words, and whose microphone they came from. */
export interface FakeSpeechMessage {
  /** The LiveKit identity of the person who "said" it. */
  identity: string;
  text: string;
}

/** A fake-speech message from the wire, or `undefined` when it is not a valid one. */
export function parseFakeSpeechMessage(raw: unknown): FakeSpeechMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { identity, text } = raw as { identity?: unknown; text?: unknown };
  if (typeof identity !== 'string' || identity.trim() === '' || typeof text !== 'string') return undefined;
  const trimmed = text.trim().slice(0, MAX_FAKE_SPEECH_LENGTH);
  return trimmed === '' ? undefined : { identity: identity.trim(), text: trimmed };
}

/** Longest line the dev-only fake recogniser accepts. */
export const MAX_FAKE_SPEECH_LENGTH = 500;

/**
 * What a browser may still send on {@link CONTROL_TOPIC}. Text, typing, Stop and Resume are gone:
 * speaking is the only way into a meeting. Start is kept only so the runner can log and ignore it,
 * because the server owns Start.
 */
export type ControlMessage = {
  /**
   * The person has read their briefing and starts the meeting: until then the AI attendees stay silent.
   * `requestId` and `session` let a retry be acknowledged once and only for the visitor who asked.
   */
  kind: 'start';
  requestId?: string;
  session?: string;
};

/** A control message from the wire, or `undefined` when it is not a valid one. */
export function parseControlMessage(raw: unknown): ControlMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const message = raw as { kind?: unknown; requestId?: unknown; session?: unknown };
  if (message.kind !== 'start') return undefined;
  if (message.requestId === undefined && message.session === undefined) {
    return { kind: 'start' };
  }
  if (typeof message.requestId === 'string' && message.requestId.trim().length > 0 &&
      typeof message.session === 'string' && message.session.trim().length > 0) {
    return { kind: 'start', requestId: message.requestId, session: message.session };
  }
  return undefined;
}

/** What the AI attendees are doing, sent on {@link NPC_STATE_TOPIC}. */
export type NpcStateMessage =
  /** `yourTurn`: the last thing the room said was a question for the person; it is the question. */
  | { kind: 'idle'; yourTurn?: string; canLock?: boolean }
  | { kind: 'thinking'; canLock?: boolean }
  | { kind: 'speaking'; speaker: string; canLock?: boolean }
  | { kind: 'error'; message: string }
  /** The NPC accepted a Start request: the browser can stop retrying and let the meeting open. */
  | { kind: 'started'; requestId: string; session: string };

/** One person's microphone state as the server-side recogniser sees it. */
export type SpeechState = 'listening' | 'transcribing' | 'failed';

/** What the runner knows about one person's speech right now. */
export interface SpeechStatusEntry {
  state: SpeechState;
  /** For `failed`, what the person should do next; shown only on their own screen. */
  message?: string;
}

/** What the runner reports on {@link SPEECH_STATUS_TOPIC}. */
export interface SpeechStatusMessage {
  /** Keyed by LiveKit participant identity, so each tile only shows its own person's state. */
  participants: Record<string, SpeechStatusEntry>;
  /** Present when recognition keeps failing: the whole room should hear instead. */
  outage?: { message: string };
}

/** True when `raw` is a complete speech-status message; malformed data is ignored. */
export function parseSpeechStatusMessage(raw: unknown): SpeechStatusMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const participants = (raw as { participants?: unknown }).participants;
  if (typeof participants !== 'object' || participants === null || Array.isArray(participants)) return undefined;
  const parsed: Record<string, SpeechStatusEntry> = {};
  for (const [identity, value] of Object.entries(participants)) {
    if (identity.trim() === '' || typeof value !== 'object' || value === null) return undefined;
    const state = (value as { state?: unknown }).state;
    if (state !== 'listening' && state !== 'transcribing' && state !== 'failed') return undefined;
    const message = (value as { message?: unknown }).message;
    if (message !== undefined && typeof message !== 'string') return undefined;
    parsed[identity] = { state, ...(message === undefined ? {} : { message }) };
  }
  const outage = (raw as { outage?: unknown }).outage;
  if (outage === undefined) return { participants: parsed };
  if (typeof outage !== 'object' || outage === null || typeof (outage as { message?: unknown }).message !== 'string') {
    return undefined;
  }
  return { participants: parsed, outage: { message: (outage as { message: string }).message } };
}

/**
 * The LiveKit room one meeting of a scenario happens in. The meeting identity is part of the room
 * name, so a token minted for an old meeting can never join the room of the meeting that replaces it.
 */
export function demoRoomName(scenario: Scenario, meetingId: string): string {
  return `kaki-demo-${scenario.id}-${meetingId}`;
}

/**
 * The fixed LiveKit identity of the runner's silent speech listener. It joins every meeting so the
 * server can hear people even when the meeting has no AI cast, and is never a person or an AI attendee.
 */
export const KAKI_LISTENER_IDENTITY = 'kaki-listener';

/** True when a LiveKit identity belongs to the runner's technical listener rather than a person. */
export function isKakiListener(identity: string | undefined): boolean {
  return identity !== undefined && identity.trim().toLowerCase() === KAKI_LISTENER_IDENTITY;
}

/** True when `name` is a person in the room: neither the runner's listener nor one of `aiNames`. */
export function isHumanParticipant(name: string, aiNames: readonly string[]): boolean {
  const wanted = name.trim().toLowerCase();
  return !isKakiListener(wanted) && !aiNames.some((aiName) => aiName.trim().toLowerCase() === wanted);
}

/** True when an AI always plays this attendee: it has a profile and a person cannot take its seat. */
function isPlayedByAi(scenario: Scenario, attendee: Attendee): boolean {
  return (scenario.npcs ?? []).some((npc) => npc.attendee === attendee.name && npc.playable !== true);
}

/**
 * The AI attendees of a session: every profile except the seat the person took. With no seat
 * (nobody has joined yet) it is the characters that are always AI.
 */
export function aiCast(scenario: Scenario, humanSeat?: string): NpcProfile[] {
  return (scenario.npcs ?? []).filter((npc) =>
    humanSeat === undefined ? npc.playable !== true : npc.attendee !== humanSeat,
  );
}

/** Every seat a person can take, including a human host: a role whose attendee is not always an AI. */
export function humanSeatRoles(scenario: Scenario): ScenarioRole[] {
  return scenario.roles.filter((role) =>
    scenario.attendees.some((attendee) => attendee.role === role.id && !isPlayedByAi(scenario, attendee)),
  );
}

/** The non-host roles a person can take in the demo meeting: a phone seat, not the facilitator's chair. */
export function humanRoles(scenario: Scenario): ScenarioRole[] {
  return humanSeatRoles(scenario).filter((role) => role.facilitator !== true);
}

/**
 * The attendee a person plays when they pick a role, by canonical role id. Labels are display-only:
 * a label is not a role identity and never resolves a seat.
 */
export function humanAttendeeForRole(scenario: Scenario, roleId: string): Attendee | undefined {
  const wanted = roleId.trim().toLowerCase();
  const role = scenario.roles.find((candidate) => candidate.id.toLowerCase() === wanted);
  if (role === undefined) return undefined;
  return scenario.attendees.find((attendee) => attendee.role === role.id && !isPlayedByAi(scenario, attendee));
}

/**
 * The role a person can take to run the meeting: the facilitator role, when its attendee's character is `playable`.
 * Taking it sends the AI host out of the cast, so the person hosts and the AI attendees follow their lead.
 */
export function hostRole(scenario: Scenario): ScenarioRole | undefined {
  return scenario.roles.find(
    (role) =>
      role.facilitator === true &&
      scenario.attendees.some((attendee) => attendee.role === role.id && !isPlayedByAi(scenario, attendee)) &&
      (scenario.npcs ?? []).some((npc) => scenario.attendees.some((a) => a.name === npc.attendee && a.role === role.id)),
  );
}

/**
 * The roles the join form offers. When the server names the setup's person seats, those ids are the
 * offered seats (a role added in setup included); otherwise every human seat, plus a host's chair a
 * person can take. Ids are canonical; labels are display-only.
 */
export function joinSeatRoles(scenario: Scenario): ScenarioRole[] {
  if (scenario.joinSeats === undefined) {
    const host = hostRole(scenario);
    return host === undefined ? humanRoles(scenario) : [...humanRoles(scenario), host];
  }
  const byId = new Map(scenario.roles.map((role) => [role.id, role]));
  const seen = new Set<string>();
  const roles: ScenarioRole[] = [];
  for (const id of scenario.joinSeats) {
    if (seen.has(id)) continue;
    const role = byId.get(id);
    if (role === undefined) continue;
    seen.add(id);
    roles.push(role);
  }
  return roles;
}

/** How many seats a person can take in this scenario: every attendee no AI always plays. */
export function humanSeatCount(scenario: Scenario): number {
  return scenario.attendees.filter((attendee) => !isPlayedByAi(scenario, attendee)).length;
}

/**
 * How many people may be in the meeting at once: the scenario's configured human seats, optionally
 * capped further. A meeting with AI stand-ins takes exactly one person: the AI colleagues follow one
 * human guest and cannot tell two people apart, so only human-only meetings hold several people.
 */
export function humanSeatCapacity(scenario: Scenario, maxHumans?: number): number {
  const hasAiStandIns = (scenario.npcs ?? []).length > 0;
  const seats = hasAiStandIns ? Math.min(1, humanSeatCount(scenario)) : humanSeatCount(scenario);
  const requested = maxHumans === undefined || !Number.isFinite(maxHumans) ? seats : Math.floor(maxHumans);
  return Math.max(0, Math.min(requested, seats));
}

/**
 * Why a person cannot take a seat right now, or `undefined` if they can. `present` are the people already in the room.
 * A seat holds one person, and the meeting never holds more people than it has human seats.
 */
export function seatProblem(
  scenario: Scenario,
  present: ReadonlyArray<{ role?: string }>,
  wantedRole: string | undefined,
  maxHumans?: number,
): string | undefined {
  // When the server names the setup's person seats, those seats decide the cap and who is sitting
  // where, including a role the owner added in setup. AI stand-ins still limit the meeting to one.
  const namedSeats = scenario.joinSeats;
  const requested = maxHumans === undefined || !Number.isFinite(maxHumans) ? undefined : Math.floor(maxHumans);
  const hasAiStandIns = (scenario.npcs ?? []).length > 0;
  const seats =
    namedSeats === undefined
      ? undefined
      : hasAiStandIns
        ? Math.min(1, namedSeats.length)
        : namedSeats.length;
  const cap =
    seats === undefined
      ? humanSeatCapacity(scenario, maxHumans)
      : Math.max(0, Math.min(requested ?? seats, seats));
  if (cap === 0) return 'No human seats are available in this meeting.';
  if (namedSeats !== undefined) {
    const wanted = wantedRole?.trim().toLowerCase();
    if (
      wanted !== undefined &&
      present.some(
        (person) => person.role !== undefined && person.role.trim().toLowerCase() === wanted,
      )
    ) {
      return `That seat is taken. Pick another role.`;
    }
  } else {
    const seat = wantedRole === undefined ? undefined : humanAttendeeForRole(scenario, wantedRole);
    if (
      seat !== undefined &&
      present.some(
        (person) => person.role !== undefined && humanAttendeeForRole(scenario, person.role)?.name === seat.name,
      )
    ) {
      return `${seat.name}'s seat is taken. Pick another role.`;
    }
  }
  if (present.length >= cap) {
    const why = (scenario.npcs ?? []).length > 0 ? ' Meetings with AI stand-ins take one person.' : '';
    return `The meeting is full (${cap} ${cap === 1 ? 'person' : 'people'} at most).${why} Try again when someone leaves.`;
  }
  return undefined;
}

/** How long a seat kept for a departed person stays held, in words the join form can show. */
export function rejoinGraceDuration(graceMs: number): string {
  if (graceMs < 60_000) {
    const seconds = Math.max(1, Math.round(graceMs / 1_000));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.round(graceMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Why a seat is not free although its holder has left: the rejoin grace keeps it for them. */
export function seatKeptForDepartedMessage(graceMs: number): string {
  return (
    `That seat is being kept for someone who just left. ` +
    `It frees within about ${rejoinGraceDuration(graceMs)}, or pick another seat.`
  );
}

/** Case, spaces and dashes do not matter when a code is typed. */
export function normalizeMeetingCode(code: string | undefined): string {
  return (code ?? '').toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Why someone cannot join with this code, or `undefined` if they can. The first person into an empty room needs no
 * code (they are shown it); anyone joining people who are already there must give it.
 */
export function codeProblem(peoplePresent: number, expected: string, given: string | undefined): string | undefined {
  if (peoplePresent === 0) return undefined;
  const typed = normalizeMeetingCode(given);
  if (typed === normalizeMeetingCode(expected)) return undefined;
  return typed.length === 0 ? 'This meeting needs its code. Ask the person already in the meeting.' : 'That meeting code is not right.';
}

/** How the person takes part in an agenda item: they watch, it is theirs, or they are asked to settle a disagreement. */
type ItemMode = 'observe' | 'involve' | 'decide';

/**
 * Worked out from who the person is, not fixed in the scenario: a contested item is `decide`, an item owned by the
 * person's own role is `involve`, and any other item is `observe`. A person who picks another role gets different items to take part in.
 * `visitorRole` is the role's canonical id.
 */
export function itemMode(scenario: Scenario, item: AgendaItem | undefined, visitorRole: string | undefined): ItemMode {
  if (item === undefined) return 'observe';
  if (item.contested === true) return 'decide';
  const key = visitorRole?.trim().toLowerCase();
  const role = key === undefined ? undefined : scenario.roles.find((candidate) => candidate.id.toLowerCase() === key);
  return role !== undefined && role.id === item.ownerRole ? 'involve' : 'observe';
}

/**
 * Reorder a scenario's agenda for a new visitor so every visitor gets a fresh opening topic
 * and an item they actively participate in (`involve` or `decide`) comes first.
 * When `maxItems` is given, trims the returned agenda to a crisp subset (for example 2 items:
 * 1 AI-colleague-led item + 1 item owned by the visitor's role). A subset never contains a pair
 * listed in the scenario's `excludedPairs`: the next allowed item is picked instead.
 */
export function shuffleAgendaForRole(
  scenario: Scenario,
  visitorRole?: string,
  random: () => number = Math.random,
  maxItems?: number,
): AgendaItem[] {
  const excluded = scenario.excludedPairs ?? [];
  const conflicts = (a: string, b: string): boolean =>
    excluded.some(([left, right]) => (left === a && right === b) || (left === b && right === a));
  const select = (list: AgendaItem[]): AgendaItem[] => {
    if (maxItems === undefined || maxItems <= 0) return list;
    const chosen: AgendaItem[] = [];
    for (const item of list) {
      if (chosen.length >= maxItems) break;
      if (chosen.every((earlier) => !conflicts(earlier.title, item.title))) chosen.push(item);
    }
    return chosen;
  };
  const items = [...scenario.agenda];
  if (items.length <= 1) return select(items);

  const previousFirstTitle = items[0]?.title;
  const shuffle = (list: AgendaItem[]): AgendaItem[] => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  };

  let shuffled = shuffle(items);
  // Prefer a fresh opening item compared to the previous order when possible.
  if (shuffled.length > 1 && shuffled[0]?.title === previousFirstTitle) {
    shuffled = [...shuffled.slice(1), shuffled[0]!];
  }

  const key = visitorRole?.trim().toLowerCase();
  const role = key === undefined ? undefined : scenario.roles.find((candidate) => candidate.id.toLowerCase() === key);

  const aiColleagues = new Set(
    scenario.attendees
      .filter((a) => {
        const r = scenario.roles.find((candidate) => candidate.id === a.role);
        return r?.facilitator !== true && (role === undefined || a.role !== role.id);
      })
      .map((a) => a.name),
  );
  const participantsOf = (item: AgendaItem | undefined): Set<string> => {
    const names = new Set<string>();
    const ownerName = scenario.attendees.find((a) => a.role === item?.ownerRole)?.name;
    if (ownerName !== undefined) names.add(ownerName);
    for (const view of item?.discussion?.openingViews ?? []) names.add(view.attendee);
    for (const to of item?.discussion?.tradeOffs ?? []) names.add(to.attendee);
    return names;
  };
  const coversAllColleagues = (first: AgendaItem | undefined, second: AgendaItem | undefined): boolean => {
    if (aiColleagues.size === 0) return true;
    const combined = new Set([...participantsOf(first), ...participantsOf(second)]);
    for (const colleague of aiColleagues) {
      if (!combined.has(colleague)) return false;
    }
    return true;
  };

  // Always prefer starting the meeting with an item led by one of the AI colleagues on stage (not the visitor's own seat)
  // so an AI colleague kicks off the discussion and gives background first instead of putting the visitor on the spot cold!
  const visitorOwnedItem = role === undefined ? undefined : shuffled.find((item) => item.ownerRole === role.id);
  const fullCoverageAiLedIdx = shuffled.findIndex(
    (item) =>
      (role === undefined || item.ownerRole !== role.id) &&
      itemMode(scenario, item, visitorRole) !== 'observe' &&
      coversAllColleagues(item, visitorOwnedItem),
  );
  const aiLedIdx =
    fullCoverageAiLedIdx >= 0
      ? fullCoverageAiLedIdx
      : shuffled.findIndex(
          (item) => (role === undefined || item.ownerRole !== role.id) && itemMode(scenario, item, visitorRole) !== 'observe',
        );
  if (aiLedIdx > 0) {
    const [picked] = shuffled.splice(aiLedIdx, 1);
    shuffled.unshift(picked!);
  }
  if (aiLedIdx >= 0) {
    // Place the item owned by the visitor's own role right into slot 1 (the 2nd agenda item) so they get their own
    // topic and task early in the meeting without waiting until the end.
    const visitorOwnedIdx =
      role === undefined ? -1 : shuffled.findIndex((item, index) => index > 0 && item.ownerRole === role.id);
    if (visitorOwnedIdx > 1) {
      const [visitorItem] = shuffled.splice(visitorOwnedIdx, 1);
      shuffled.splice(1, 0, visitorItem!);
    }
    return select(shuffled);
  }

  // Fallback: pull an item the visitor owns ('involve') or decides on ('decide') into the opening slot.
  const involveIdx = shuffled.findIndex((item) => itemMode(scenario, item, visitorRole) === 'involve');
  if (involveIdx > 0) {
    const [picked] = shuffled.splice(involveIdx, 1);
    shuffled.unshift(picked!);
    return select(shuffled);
  }
  if (involveIdx === 0) return select(shuffled);

  const decideIdx = shuffled.findIndex((item) => itemMode(scenario, item, visitorRole) === 'decide');
  if (decideIdx > 0) {
    const [picked] = shuffled.splice(decideIdx, 1);
    shuffled.unshift(picked!);
  }
  return select(shuffled);
}

/**
 * Replace the active agenda in place while keeping the source ready for later meeting draws.
 * The picked item's minutes and owner are applied over the source item, so an edited setup takes
 * effect. A title the pack does not have is only allowed when `allowPlain` is set (a setup item
 * with no briefing); every other caller still fails loudly on an unknown title.
 */
export function setMeetingAgenda(
  target: Scenario,
  full: Scenario,
  picked: readonly AgendaItem[],
  { allowPlain = false }: { allowPlain?: boolean } = {},
): void {
  const titles = new Set(picked.map((item) => item.title));
  const sourceItems = new Map(full.agenda.map((item) => [item.title, item]));
  const meetingItems = picked.map((item) => {
    const source = sourceItems.get(item.title);
    if (source === undefined) {
      if (!allowPlain) throw new Error(`Unknown meeting agenda title: ${item.title}`);
      return {
        title: item.title,
        minutes: item.minutes,
        canWait: item.canWait,
        deadline: item.deadline,
        ownerRole: item.ownerRole,
      };
    }
    const links = source.links?.filter((link) => titles.has(link.with));
    const { links: _links, ...withoutLinks } = source;
    return {
      ...(links?.length ? { ...withoutLinks, links } : withoutLinks),
      minutes: item.minutes,
      ownerRole: item.ownerRole,
    };
  });
  const pairs = full.excludedPairs?.filter(([left, right]) => titles.has(left) && titles.has(right));
  target.agenda.splice(0, target.agenda.length, ...meetingItems);
  if (pairs?.length) target.excludedPairs = pairs;
  else delete target.excludedPairs;
}

/**
 * Resolve `KAKI_AGENDA_PICK` (comma-separated agenda titles or 0-based canon indexes) to an
 * ordered agenda subset for repeatable playtests. Unknown titles, out-of-range indexes,
 * duplicates and excluded pairs are refused with a clear error.
 */
export function resolveAgendaPick(scenario: Scenario, spec: string): AgendaItem[] {
  const parts = spec.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error('KAKI_AGENDA_PICK must name at least one agenda title or 0-based index');
  }
  const titles = scenario.agenda.map((item) => item.title);
  const picked = parts.map((part) => {
    if (/^\d+$/.test(part)) {
      const index = Number(part);
      const item = scenario.agenda[index];
      if (item === undefined) {
        throw new Error(
          `KAKI_AGENDA_PICK index ${index} is out of range; the agenda has ${scenario.agenda.length} items (0-${scenario.agenda.length - 1})`,
        );
      }
      return item;
    }
    const wanted = part.toLowerCase();
    const item = scenario.agenda.find((candidate) => candidate.title.toLowerCase() === wanted);
    if (item === undefined) {
      throw new Error(`KAKI_AGENDA_PICK has unknown agenda title "${part}". Known titles: ${titles.join(' | ')}`);
    }
    return item;
  });
  const seen = new Set<string>();
  for (const item of picked) {
    if (seen.has(item.title)) throw new Error(`KAKI_AGENDA_PICK names "${item.title}" more than once`);
    seen.add(item.title);
  }
  const excluded = scenario.excludedPairs ?? [];
  for (let index = 0; index < picked.length; index += 1) {
    for (let other = index + 1; other < picked.length; other += 1) {
      const a = picked[index]!.title;
      const b = picked[other]!.title;
      if (excluded.some(([left, right]) => (left === a && right === b) || (left === b && right === a))) {
        throw new Error(`KAKI_AGENDA_PICK cannot draw "${a}" with "${b}": they are an excluded pair`);
      }
    }
  }
  return picked;
}
