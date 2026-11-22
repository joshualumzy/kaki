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
export function realBaseScenario(row: Pick<MeetingRow, 'id' | 'title' | 'agenda'>): Scenario {
  const agenda: Scenario['agenda'] = row.agenda.map((item: AgendaItem) => ({
    title: item.title,
    minutes: item.minutes ?? 10,
    canWait: true,
    deadline: 'today',
    ownerRole: REAL_BASE_ROLE,
  }));
  return {
    id: `real-${row.id}`,
    meetingTitle: row.title,
    roles: [{ id: REAL_BASE_ROLE, label: REAL_BASE_LABEL }],
    attendees: [],
    agenda,
    joinSeats: [],
  };
}

function personName(holder: SeatHolder): string {
  return holder.displayName?.trim() || holder.name.trim();
}

function uniqueRoles(base: readonly ScenarioRole[], holders: readonly SeatHolder[]): ScenarioRole[] {
  const seen = new Set(base.map((role) => role.id));
  const roles = [...base];
  for (const holder of holders) {
    if (seen.has(holder.seat)) continue;
    seen.add(holder.seat);
    roles.push({ id: holder.seat, label: personName(holder) });
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

/** The setup Start seals for a real meeting: its people are the seats, its agenda is the meeting's. */
export function realMeetingSetup(base: Scenario, holders: readonly SeatHolder[]): MeetingSetup {
  return {
    title: base.meetingTitle,
    agenda: base.agenda.map((item, index) => ({
      id: `agenda-${index + 1}`,
      title: item.title,
      minutes: item.minutes,
      ownerRoleId: REAL_BASE_ROLE,
    })),
    roles: uniqueRoles(base.roles, holders).map((role) => ({
      id: role.id,
      label: role.label,
      facilitator: false,
    })),
    seats: holders.map((holder) => ({
      displayName: personName(holder),
      roleId: holder.seat,
      kind: 'person' as const,
    })),
    pace: { ...DEFAULT_MEETING_PACE },
    source: { title: 'typed', agenda: 'typed', roles: 'typed', seats: 'typed', pace: 'typed' },
  };
}

function identitySeat(label: string): string {
  return `person_${createHash('sha256').update(label).digest('hex').slice(0, 20)}`;
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
      if (principal.userId !== undefined) return identitySeat(`user:${principal.userId}`);
      break;
    case 'user':
      return identitySeat(`user:${principal.userId}`);
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

/** The name a real meeting shows: the account's, the guest's own, or the one they typed. */
export function realPersonName(principal: Principal, typedName: string): string {
  if (principal.kind === 'host' || principal.kind === 'user' || principal.kind === 'guest') {
    const name = principal.name?.trim() ?? '';
    if (name !== '') return name;
  }
  return typedName.trim();
}
