import { describe, expect, it, vi } from 'vitest';
import { KOPITIAM_INVITE_UID, parseMeetingInvite } from '@kaki/shared';
import { buildSeedInvite, buildSeedInviteIcs, seedCalendar } from './calendar';
import { loadScenarioSeed } from './scenario';

describe('Kopitiam invite seed', () => {
  const seed = loadScenarioSeed('kopitiam');

  it('generates a description that round-trips through the parser to the scenario agenda', () => {
    const invite = buildSeedInvite(seed);
    const parsed = parseMeetingInvite(buildSeedInviteIcs(seed));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const expectedAgenda = seed.meeting.agenda.map((item) => {
      const attendee = seed.meeting.attendees.find((person) => person.role === item.ownerRole);
      const role = seed.meeting.roles.find((candidate) => candidate.id === item.ownerRole);
      return { title: item.title, minutes: item.minutes, owner: attendee?.name ?? role?.label ?? item.ownerRole };
    });

    expect(parsed.value.uid).toBe(KOPITIAM_INVITE_UID);
    expect(parsed.value.title).toBe(seed.meeting.title);
    expect(parsed.value.agenda).toEqual(expectedAgenda);
    expect(parsed.value.people).toEqual(seed.meeting.attendees.map((person) => person.name));
    expect(parsed.value).toEqual(invite);
  });

  it('writes the invite with its attendees and UID', async () => {
    const puts: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'PUT') puts.push({ url: String(url), body: String(init.body) });
      return new Response('', { status: 201 });
    });

    await seedCalendar(seed, { fetchImpl });

    const invitePut = puts.find((put) => put.url.endsWith(`${KOPITIAM_INVITE_UID}.ics`));
    expect(invitePut).toBeDefined();
    expect(invitePut?.body).toContain(`UID:${KOPITIAM_INVITE_UID}`);
    expect(invitePut?.body).toContain('DESCRIPTION:Agenda\\n');
    expect(invitePut?.body).toContain('ATTENDEE;CN="Wei Ling"');
  });

  it('fails the seed when Radicale refuses an event', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) =>
      new Response('', { status: init?.method === 'PUT' ? 500 : 201 }),
    );

    await expect(seedCalendar(seed, { fetchImpl })).rejects.toThrow(/Radicale.*HTTP 500/);
  });
});
