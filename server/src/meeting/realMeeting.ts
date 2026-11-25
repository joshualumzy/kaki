import { createHash } from 'node:crypto';
import {
  DEFAULT_MEETING_PACE,
  type MeetingSetup,
  type Scenario,
  type ScenarioRole,
} from '@kaki/shared';
import type { Principal } from '../http/access';
import type { SeatHolder } from './rejoin';
import type { AgendaItem, MeetingRow } from './types';

/** The one generic role a real meeting's agenda items name; it is never a person's seat. */
export const REAL_BASE_ROLE = 'everyone';

/** The label the base role shows when an agenda item points at it. */
const REAL_BASE_LABEL = 'Everyone';

/** The plain scenario a real meeting starts from: its own title and agenda, no pack content. */
export function realBaseScenario(
  row: Pick<MeetingRow, 'id' | 'title' | 'agenda' | 'ownerUserId'>,
): Scenario {
  const agenda: Scenario['agenda'] = row.agenda.map((item: AgendaItem) => ({
    title: item.title,
    minutes: item.minutes ?? 10,
    canWait: true,
    deadline: 'today',
    // The owner is a stable account id, never a name: the same identity the person joins with.
    ownerRole:
      item.ownerUserId === undefined ? REAL_BASE_ROLE : userRoomIdentity(item.ownerUserId),
  }));
  // The owner chairs a real meeting, so their plain seat is the facilitator. Without that identity
  // the shared screen has no seat to speak from, and Start could never end the meeting either.
  const ownerRole: ScenarioRole[] =
    row.ownerUserId === null
      ? []
      : [{ id: identitySeat(`user:${row.ownerUserId}`), label: 'Owner', facilitator: true }];
  return {
    id: `real-${row.id}`,
    meetingTitle: row.title,
    roles: [{ id: REAL_BASE_ROLE, label: REAL_BASE_LABEL }, ...ownerRole],
    attendees: [],
    agenda,
    joinSeats: [],
  };
}

function personName(holder: SeatHolder): string {
  return holder.displayName?.trim() || holder.name.trim();
}

function uniqueRoles(base: readonly ScenarioRole[], holders: readonly SeatHolder[]): ScenarioRole[] {
  const roles = base.map((role) => ({ ...role }));
  for (const holder of holders) {
    const index = roles.findIndex((role) => role.id === holder.seat);
    const existing = roles[index];
    if (existing === undefined) roles.push({ id: holder.seat, label: personName(holder) });
    else roles[index] = { ...existing, label: personName(holder) };
  }
  return roles;
}

/** The scenario a real meeting shows with the people in it: one plain seat per person, by name. */
export function realScenarioWithPeople(base: Scenario, holders: readonly SeatHolder[]): Scenario {
  return {
    ...base,
    roles: uniqueRoles(base.roles, holders),
    attendees: holders.map((holder) => {
      const name = personName(holder);
      return { name, role: holder.seat, displayName: name };
    }),
  };
}

/** Bind only an exact, uniquely held seat id. Names never establish agenda ownership. */
function realAgendaOwner(
  configured: MeetingSetup | undefined,
  item: Scenario['agenda'][number],
  index: number,
  holders: readonly SeatHolder[],
): string {
  const candidate = configured?.agenda.find((entry) => entry.title === item.title) ?? configured?.agenda[index];
  const role = candidate?.ownerRoleId.trim();
  if (role === undefined || role === REAL_BASE_ROLE) return REAL_BASE_ROLE;
  const matches = holders.filter((holder) => holder.seat === role);
  return matches.length === 1 ? matches[0]!.seat : REAL_BASE_ROLE;
}

/**
 * The setup Start seals for a real meeting: its people are the seats, its agenda is the meeting's.
 * The owner's configured pace and the agenda owner's seat identity carry over from the
 * draft. Cue delivery resolves that identity against the current holders, never their names.
 */
export function realMeetingSetup(
  base: Scenario,
  holders: readonly SeatHolder[],
  configured?: MeetingSetup,
): MeetingSetup {
  const roles = uniqueRoles(base.roles, holders);
  return {
    title: base.meetingTitle,
    agenda: base.agenda.map((item, index) => ({
      id: `agenda-${index + 1}`,
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: realAgendaOwner(configured, item, index, holders),
    })),
    roles: roles.map((role) => ({
      id: role.id,
      label: role.label,
      facilitator: role.facilitator === true,
    })),
    seats: holders.map((holder) => ({
      displayName: personName(holder),
      roleId: holder.seat,
      kind: 'person' as const,
    })),
    pace: { ...(configured?.pace ?? DEFAULT_MEETING_PACE) },
    source: { title: 'typed', agenda: 'typed', roles: 'typed', seats: 'typed', pace: 'typed' },
  };
}

/** The scenario a real meeting runs: the sealed owners reach the agenda the notetaker and cues read. */
export function realMeetingScenario(
  base: Scenario,
  holders: readonly SeatHolder[],
  configured?: MeetingSetup,
): Scenario {
  const sealed = realMeetingSetup(base, holders, configured);
  const owners = new Map(sealed.agenda.map((item, index) => [index, item.ownerRoleId]));
  return realScenarioWithPeople(
    {
      ...base,
      agenda: base.agenda.map((item, index) => ({
        ...item,
        ownerRole: owners.get(index) ?? REAL_BASE_ROLE,
      })),
    },
    holders,
  );
}

function identitySeat(label: string): string {
  return `person_${createHash('sha256').update(label).digest('hex').slice(0, 20)}`;
}

/** The stable LiveKit identity a signed-in account takes in a real meeting. */
export function userRoomIdentity(userId: string): string {
  return identitySeat(`user:${userId}`);
}

/**
 * The stable seat a person owns in a real meeting. It follows who they are, never their display
 * name: a signed-in user keeps it across sessions, a guest keeps it with the guest cookie they
 * joined with, and two people who share a name still get different seats.
 */
export function realSeatId(
  principal: Principal,
  participantName: string,
  meetingId: string,
): string {
  switch (principal.kind) {
    case 'seat':
      return principal.role;
    case 'host':
      if (principal.seat !== undefined && principal.seat.trim() !== '') return principal.seat;
      if (principal.userId !== undefined) return userRoomIdentity(principal.userId);
      break;
    case 'user':
      return userRoomIdentity(principal.userId);
    case 'guest':
      if (principal.guestId !== undefined && principal.guestId !== '') {
        return identitySeat(`guest:${principal.guestId}`);
      }
      break;
    default:
      break;
  }
  return identitySeat(`name:${participantName.trim().toLowerCase()}|${meetingId}`);
}

/**
 * The holder a room participant's LiveKit identity names. A real meeting's token makes the stable
 * seat id the room identity, so the identity finds the holder by seat. Practice keeps the person's
 * display name as the room identity, so the same lookup falls back to a name only when no holder
 * has that seat id. This is the one rule every speech line is matched by, and it never lets a
 * shared display name decide between two real seats.
 */
export function holderForRoomIdentity(
  holders: readonly SeatHolder[],
  participantIdentity: string,
): SeatHolder | undefined {
  const identity = participantIdentity.trim().toLowerCase();
  if (identity === '') return undefined;
  const bySeat = holders.find((holder) => holder.seat.trim().toLowerCase() === identity);
  if (bySeat !== undefined) return bySeat;
  return holders.find((holder) => holder.name.trim().toLowerCase() === identity);
}

/** The name a real meeting shows: the account's, the guest's own, or the one they typed. */
export function realPersonName(principal: Principal, typedName: string): string {
  if (principal.kind === 'host' || principal.kind === 'user' || principal.kind === 'guest') {
    const name = principal.name?.trim() ?? '';
    if (name !== '') return name;
  }
  return typedName.trim();
}
