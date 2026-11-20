import { buildMeetingInviteIcs, KOPITIAM_INVITE_UID, type MeetingInvite } from '@kaki/shared';
import type { ScenarioSeed } from './scenario';

const DEFAULT_CALENDAR_URL = 'http://127.0.0.1:5232/user/calendar/';
const REQUEST_TIMEOUT_MS = 20_000;

interface SeedCalendarOptions {
  fetchImpl?: typeof fetch;
  calendarUrl?: string;
}

/** The Kopitiam meeting invite, generated from the scenario so the agenda cannot drift. */
export function buildSeedInvite(seed: ScenarioSeed): MeetingInvite {
  const roleById = new Map(seed.meeting.roles.map((role) => [role.id, role]));
  const attendeeByRole = new Map(seed.meeting.attendees.map((person) => [person.role, person]));

  return {
    uid: KOPITIAM_INVITE_UID,
    title: seed.meeting.title,
    agenda: seed.meeting.agenda.map((item) => ({
      title: item.title,
      minutes: item.minutes,
      owner: attendeeByRole.get(item.ownerRole)?.name ?? roleById.get(item.ownerRole)?.label ?? item.ownerRole,
    })),
    people: seed.meeting.attendees.map((person) => person.name),
  };
}

export function buildSeedInviteIcs(seed: ScenarioSeed): string {
  return buildMeetingInviteIcs(buildSeedInvite(seed), {
    start: '2026-11-11 07:30',
    end: '2026-11-11 08:00',
  });
}

function eventLines(seed: ScenarioSeed): Array<{ id: string; dtstart: string; dtend: string; summary: string; description: string }> {
  const trialDay = '20261110';
  const openingDay = '20261111';
  const plus2 = '20261113';
  const plus5 = '20261116';

  return [
    {
      id: 'seed-trial-day',
      dtstart: `${trialDay}T080000`,
      dtend: `${trialDay}T103000`,
      summary: 'Raffles Place - Trial-Day Breakfast Service',
      description: 'Counter queue, seating turnover, new kopi prices and delivery app orders during the trial breakfast.',
    },
    {
      id: 'seed-opening-staffing-call',
      dtstart: `${openingDay}T063000`,
      dtend: `${openingDay}T070000`,
      summary: 'Opening Day - Counter Cover Call',
      description: 'Two counter staff planned for 8 to 10; Siti is out for a family emergency after texting at quarter to seven. Rest-day double pay, agency notice and till login on the table.',
    },
    {
      id: 'seed-opening-fridge-check',
      dtstart: `${openingDay}T061500`,
      dtend: `${openingDay}T064500`,
      summary: 'Opening Day - Prep Fridge Check and Disposal Log',
      description: 'Head chef found the prep fridge unplugged overnight after the trial, threw out the contents and signed the disposal log at 6:10.',
    },
    {
      id: 'seed-opening-delivery-review',
      dtstart: `${openingDay}T070000`,
      dtend: `${openingDay}T073000`,
      summary: 'Opening Day - Delivery App Margin Review',
      description: 'Check the 32% commission, single-set loss and the Office Platter and direct pickup margins before the app goes live.',
    },
    {
      id: 'seed-food-agency-inspection',
      dtstart: `${openingDay}T090000`,
      dtend: `${openingDay}T094500`,
      summary: 'Food Agency On-Site Inspection',
      description: 'Routine opening-day inspection booked weeks ago; the officer reviews the signed disposal log, the fridge temperature log and the delivery record for the replacement eggs and kaya.',
    },
    {
      id: 'seed-blogger-visit',
      dtstart: `${openingDay}T103000`,
      dtend: `${openingDay}T111500`,
      summary: 'Food Blogger Visit - Set A and Kopi Bar',
      description: 'Jia Hui photographs Set A, the kopi bar and the breakfast crowd.',
    },
    {
      id: 'seed-arrival-check',
      dtstart: `${openingDay}T074500`,
      dtend: `${openingDay}T080000`,
      summary: 'Opening Day - Doors Open',
      description: 'Final walk of the counter, kiosk and seating before the 8 o clock doors.',
    },
    {
      id: 'seed-post-rush-seating-review',
      dtstart: `${openingDay}T110000`,
      dtend: `${openingDay}T113000`,
      summary: 'Post-Rush Seating and Laptop Review',
      description: 'Review seat turnover, the window-bar stools and the booth socket timer after the first rush.',
    },
    {
      id: 'seed-office-pickup-follow-up',
      dtstart: `${plus2}T150000`,
      dtend: `${plus2}T160000`,
      summary: 'Office Direct Pickup Code Follow-Up',
      description: 'Agree the direct order code and pickup shelf for the 12 office managers who asked.',
    },
    {
      id: 'seed-kaya-delivery',
      dtstart: `${plus2}T070000`,
      dtend: `${plus2}T074500`,
      summary: 'Pandan Kaya and Hainanese Loaf Restock',
      description: 'Morning delivery of house pandan kaya and thick-cut loaves for the week.',
    },
    {
      id: 'seed-roaster-cupping',
      dtstart: `${plus5}T143000`,
      dtend: `${plus5}T153000`,
      summary: 'Liberica and Robusta Butter-Roast Cupping',
      description: 'Check the Nanyang roast profile and sock-brew extraction with Uncle Lim and Mei.',
    },
  ];
}

function buildEventIcs(event: ReturnType<typeof eventLines>[number]): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Kaki//NONSGML v1.0//EN',
    'BEGIN:VEVENT',
    `UID:${event.id}@kaki.local`,
    `DTSTAMP:20261111T000000Z`,
    `DTSTART:${event.dtstart}`,
    `DTEND:${event.dtend}`,
    `SUMMARY:${event.summary}`,
    `DESCRIPTION:${event.description}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

/**
 * Seed the practice calendar and the Kopitiam meeting invite. A calendar that is
 * already absent can be recreated, but a refused event write fails the seed.
 */
export async function seedCalendar(seed: ScenarioSeed, options: SeedCalendarOptions = {}): Promise<void> {
  const calendarUrl = options.calendarUrl ?? DEFAULT_CALENDAR_URL;
  const rootUrl = calendarUrl.replace(/[^/]+\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Radicale ${label} failed at ${url}: ${reason}`, { cause: error });
    }
  }

  function expect(response: Response, label: string, allowed: readonly number[] = []): void {
    if (response.ok || allowed.includes(response.status)) return;
    throw new Error(`Radicale ${label} failed: HTTP ${response.status}`);
  }

  // Clearing the collection is optional: a first run has nothing to delete.
  expect(await request(calendarUrl, { method: 'DELETE' }, 'clear calendar'), 'clear calendar', [404, 405]);
  // Creating the parent and collection is optional too: "already there" answers are fine.
  expect(await request(rootUrl, { method: 'MKCOL' }, 'create user collection'), 'create user collection', [405, 409]);
  expect(await request(calendarUrl, { method: 'MKCALENDAR' }, 'create calendar'), 'create calendar', [405, 409]);

  const events = eventLines(seed).map((event) => ({ id: event.id, ics: buildEventIcs(event) }));
  events.push({ id: KOPITIAM_INVITE_UID, ics: buildSeedInviteIcs(seed) });

  for (const event of events) {
    const response = await request(
      `${calendarUrl}${event.id}.ics`,
      { method: 'PUT', headers: { 'content-type': 'text/calendar; charset=utf-8' }, body: event.ics },
      `event ${event.id}`,
    );
    expect(response, `event ${event.id}`);
  }
}
