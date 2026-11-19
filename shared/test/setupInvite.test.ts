import { describe, expect, it } from 'vitest';
import {
  buildMeetingInviteIcs,
  KOPITIAM_INVITE_UID,
  parseMeetingInvite,
  type MeetingInvite,
} from '../src/setupInvite';

function invite(overrides: Partial<MeetingInvite> = {}): MeetingInvite {
  return {
    uid: KOPITIAM_INVITE_UID,
    title: 'Opening day huddle',
    agenda: [
      { title: 'Counter cover, opening rush', minutes: 5, owner: 'Wei Ling' },
      { title: 'Kopi prices', minutes: 3, owner: 'Mei' },
    ],
    people: ['Wei Ling', 'Mei'],
    ...overrides,
  };
}

function icsFor(value: MeetingInvite = invite()): string {
  return buildMeetingInviteIcs(value, {
    start: '2026-11-11 07:30',
    end: '2026-11-11 08:00',
  });
}

function manualIcs({ summary, description, attendees }: { summary?: string; description?: string; attendees: string[] }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kaki//NONSGML v1.0//EN',
    'BEGIN:VEVENT',
    `UID:${KOPITIAM_INVITE_UID}`,
    'DTSTART:20261111T073000',
    'DTEND:20261111T080000',
    ...(summary === undefined ? [] : [`SUMMARY:${summary}`]),
    ...(description === undefined ? [] : [`DESCRIPTION:${description}`]),
    ...attendees.map((name, index) => `ATTENDEE;CN="${name}";ROLE=REQ-PARTICIPANT:mailto:person-${index + 1}@kaki.local`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ];
  return lines.join('\r\n');
}

describe('meeting invite parser', () => {
  it('round-trips a folded, escaped description and CRLF invite', () => {
    const value = invite({
      title: 'Opening day huddle, with the whole floor team and the office crowd, before the doors open',
      agenda: [
        {
          title: 'Counter cover, opening rush, the free-kopi crowd and the office flyers that went out to the whole building',
          minutes: 5,
          owner: 'Wei Ling',
        },
        { title: 'Kopi prices; regulars', minutes: 3, owner: 'Mei' },
      ],
    });
    const ics = icsFor(value);

    expect(ics).toContain('\r\n ');
    expect(ics).toContain('\\,');
    expect(ics).toContain('\\;');

    const parsed = parseMeetingInvite(ics, { knownOwners: ['Wei Ling', 'Mei'] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(value);
  });

  it('selects the event by UID', () => {
    const other = buildMeetingInviteIcs(
      invite({ uid: 'other@kaki.local', title: 'Other event' }),
      { start: '2026-11-11 09:00', end: '2026-11-11 09:30' },
    );
    const parsed = parseMeetingInvite(other + icsFor(), { uid: KOPITIAM_INVITE_UID });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.title).toBe('Opening day huddle');
  });

  it('reports a missing agenda by field', () => {
    const parsed = parseMeetingInvite(
      manualIcs({ summary: 'No agenda', description: 'Just a note in the invite', attendees: ['Ada'] }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContainEqual(expect.objectContaining({ field: 'agenda' }));
  });

  it('reports bad minutes by field', () => {
    const parsed = parseMeetingInvite(
      manualIcs({
        summary: 'Bad minutes',
        description: 'Agenda\\n- Prep | 0 min | Ada',
        attendees: ['Ada'],
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContainEqual(expect.objectContaining({ field: 'agenda[0].minutes' }));
  });

  it('reports an owner who is not in the invite or pack', () => {
    const parsed = parseMeetingInvite(
      manualIcs({
        summary: 'Unknown owner',
        description: 'Agenda\\n- Prep | 5 min | Nobody',
        attendees: ['Ada'],
      }),
      { knownOwners: ['Chef'] },
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContainEqual(expect.objectContaining({ field: 'agenda[0].owner' }));
  });
});
