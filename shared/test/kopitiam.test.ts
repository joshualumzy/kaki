import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseScenario, type Scenario } from '../src/scenario';
import { setMeetingAgenda, shuffleAgendaForRole } from '../src/demo';

const scenarioDir = fileURLToPath(new URL('../../scenarios/kopitiam', import.meta.url));
const scenarioFile = path.join(scenarioDir, 'scenario.json');
const seedDir = path.join(scenarioDir, 'seed');

const BANNED = [
  'sous-vide',
  'egg warmer',
  '58°c',
  '#402',
  '#405',
  '$0.40',
  '$55',
  '$1.85',
  '$2.20',
  'last week',
  'hospitalised',
  'hospitalized',
  'salmonella',
  'straits times',
  '$2,000 fine',
  '2,000 fine',
  '25-person',
  'rainy-day',
  'rainy day',
  '15 riders',
  'subtitle mode',
  'tomorrow at 8:00 am',
  'kopi o kosong freeze',
  '19 of 28',
  '15 seconds',
  'kopi guide',
  '$500',
  'blocked doorway',
  'blocked-doorway',
  '12 of 24',
  '72%',
  'page two',
  'chope',
  'tissue packet',
];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function loadScenario(): Scenario {
  return parseScenario(JSON.parse(readFileSync(scenarioFile, 'utf8')) as unknown);
}

describe('shipped Kopitiam story', () => {
  it('validates every drawn meeting agenda and keeps the source intact', () => {
    const full = loadScenario();
    const original = JSON.stringify(full);
    let draws = 0;
    const visit = (choices: number[]): void => {
      if (choices.length < full.agenda.length - 1) {
        const size = full.agenda.length - choices.length;
        for (let index = 0; index < size; index += 1) visit([...choices, (index + 0.5) / size]);
        return;
      }
      for (const role of full.roles) {
        for (const maxItems of [2, 3, 4]) {
          let next = 0;
          const picked = shuffleAgendaForRole(full, role.id, () => choices[next++]!, maxItems);
          const active = { ...full, agenda: [...full.agenda] };
          setMeetingAgenda(active, full, picked);
          expect(parseScenario(JSON.parse(JSON.stringify(active)) as unknown).agenda.map((item) => item.title))
            .toEqual(picked.map((item) => item.title));
          draws += 1;
        }
      }
    };
    visit([]);
    expect(draws).toBe(full.roles.length * 3 * 120);
    expect(JSON.stringify(full)).toBe(original);
  });
  it('validates and gives every topic the v2 fields the later steps use', () => {
    const scenario = loadScenario();
    const playableRoles = (scenario.npcs ?? [])
      .filter((npc) => npc.playable === true)
      .map((npc) => scenario.attendees.find((attendee) => attendee.name === npc.attendee)?.role)
      .filter((role): role is NonNullable<typeof role> => role !== undefined);
    expect(playableRoles.length).toBeGreaterThan(0);

    for (const item of scenario.agenda) {
      expect(item.title.trim().length, `${item.title} briefing`).toBeGreaterThan(0);
      expect(item.briefing?.length, `${item.title} briefing`).toBeGreaterThan(0);
      for (const fact of item.briefing ?? []) {
        expect(fact.text.trim().length, `${item.title} briefing fact`).toBeGreaterThan(0);
      }
      expect(item.decision?.trim().length, `${item.title} decision`).toBeGreaterThan(0);
      expect(item.directions?.length, `${item.title} directions`).toBeGreaterThan(0);
      for (const role of playableRoles) {
        expect(item.seatFacts?.[role]?.trim().length, `${item.title} seat fact for ${role}`).toBeGreaterThan(0);
      }
    }
  });

  it('only links and excludes agenda titles that exist', () => {
    const scenario = loadScenario();
    const titles = new Set(scenario.agenda.map((item) => item.title));
    const indexByTitle = new Map(scenario.agenda.map((item, index) => [item.title, index]));
    const actualPairs = new Set(scenario.agenda.flatMap((item) => (item.links ?? []).map((link) =>
      [indexByTitle.get(item.title)!, indexByTitle.get(link.with)!].sort((a, b) => a - b).join('-'))));
    expect([...actualPairs].sort()).toEqual(['0-1', '0-2', '1-3', '2-4', '3-4']);
    for (const [left, right] of scenario.excludedPairs ?? []) {
      expect(titles.has(left), `excluded title ${left}`).toBe(true);
      expect(titles.has(right), `excluded title ${right}`).toBe(true);
    }
    for (const item of scenario.agenda) {
      for (const link of item.links ?? []) {
        expect(titles.has(link.with), `link from ${item.title} to ${link.with}`).toBe(true);
        const reciprocal = scenario.agenda.find((candidate) => candidate.title === link.with)?.links
          ?.some((candidate) => candidate.with === item.title);
        expect(reciprocal, `missing reciprocal link from ${link.with} to ${item.title}`).toBe(true);
        expect((scenario.excludedPairs ?? []).some(([left, right]) =>
          (left === item.title && right === link.with) || (right === item.title && left === link.with)),
        `excluded pair ${item.title} + ${link.with} must not link`).toBe(false);
      }
    }
  });

  it('keeps topic facts in agenda items and gives each topic two opening speakers', () => {
    const scenario = loadScenario();
    const seatFacts = scenario.agenda.flatMap((item) => Object.values(item.seatFacts ?? {}));
    for (const role of scenario.roles) {
      for (const fact of role.card?.facts ?? []) expect(seatFacts).not.toContain(fact);
    }
    for (const npc of scenario.npcs ?? []) {
      const profile = [npc.agenda, ...(npc.concerns ?? []), ...(npc.knows ?? []),
        ...(npc.tensions ?? []).map((tension) => tension.about)].join(' ');
      for (const fact of seatFacts) expect(profile).not.toContain(fact);
    }
    for (const item of scenario.agenda) {
      expect(item.discussion?.openingViews).toHaveLength(2);
      expect(item.discussion?.tradeOffs).toHaveLength(2);
      expect(item.discussion?.tradeOffs.map((tradeOff) => tradeOff.attendee)).toEqual(
        item.discussion?.openingViews.map((view) => view.attendee),
      );
      expect(item.art).toMatch(/^\/scenario\/crisis-[a-z-]+\.svg$/);
      expect(existsSync(path.join(scenarioDir, '../../web/public', item.art!))).toBe(true);
    }
  });

  it('gives every briefing fact a speaker from every possible guest seat, and every decision one question', () => {
    const scenario = loadScenario();
    const names = new Set(scenario.attendees.map((attendee) => attendee.name));
    const hostName = scenario.attendees.find((attendee) =>
      scenario.roles.find((role) => role.id === attendee.role)?.facilitator === true)?.name;
    expect(hostName).toBeDefined();
    for (const attendee of scenario.attendees) {
      if (attendee.name === hostName) expect(attendee.spokenJob).toBeUndefined();
      else expect(attendee.spokenJob?.trim().length, `${attendee.name} spokenJob`).toBeGreaterThan(0);
    }
    const guestSeats = (scenario.npcs ?? [])
      .filter((npc) => npc.playable === true)
      .map((npc) => npc.attendee);
    expect(guestSeats.length, 'possible guest seats').toBe(4);
    for (const item of scenario.agenda) {
      for (const fact of item.briefing ?? []) {
        const knowers = fact.knownBy.map((knower) => knower.attendee);
        expect(new Set(knowers).size, `${item.title} "${fact.text}" two different knowers`).toBeGreaterThanOrEqual(2);
        for (const knower of fact.knownBy) {
          expect(names.has(knower.attendee), `${item.title} knower ${knower.attendee}`).toBe(true);
          expect(knower.attendee, `${item.title} host in knownBy`).not.toBe(hostName);
          expect(knower.why.trim().length, `${item.title} knower reason`).toBeGreaterThan(0);
        }
        for (const guestSeat of guestSeats) {
          const present = new Set((scenario.npcs ?? []).map((npc) => npc.attendee));
          present.delete(guestSeat);
          const speaker = fact.knownBy.find((knower) =>
            knower.attendee !== guestSeat && knower.attendee !== hostName && present.has(knower.attendee));
          expect(speaker, `${item.title} / guest ${guestSeat} / "${fact.text}"`).toBeDefined();
        }
      }
      expect((item.decision?.match(/\?/g) ?? []).length, `${item.title} decision question marks`).toBe(1);
      expect(item.decision?.trim().endsWith('?'), `${item.title} decision ends with ?`).toBe(true);
    }
  });

  it('keeps proposed answers out of company records and dates opening-day mail consistently', () => {
    const records = filesUnder(seedDir).map((file) => readFileSync(file, 'utf8')).join('\n').toLowerCase();
    for (const direction of ['options raised', 'options discussed', 'the ways to keep',
      'old-price hour', 'seniors\' discount', 'a laptop zone', 'scale back the free-kopi offer']) {
      expect(records, `records must not suggest ${direction}`).not.toContain(direction);
    }
    const mail = JSON.parse(readFileSync(path.join(seedDir, 'mail/emails.json'), 'utf8')) as {
      emails: Array<{ messageId: string; date: string; subject: string; text: string }>;
    };
    const notice = mail.emails.find((email) => email.messageId.includes('food-agency-inspection'))!;
    const blogger = mail.emails.find((email) => email.messageId.includes('blogger-booking'))!;
    expect(notice.date.startsWith('2026-11-11')).toBe(true);
    expect(notice.text).toContain('11 November at 9:00 AM');
    expect(blogger.date.startsWith('2026-11-10')).toBe(true);
    expect(blogger.text).toContain('10:30 tomorrow morning');
  });

  it('contains none of the old story terms in the scenario or any seed file', () => {
    const corpus = [scenarioFile, ...filesUnder(seedDir)]
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
      .toLowerCase();
    for (const term of BANNED) {
      expect(corpus.includes(term), `old story term "${term}"`).toBe(false);
    }
  });

  it('carries every seat-fact figure in at least one company record', () => {
    const scenario = loadScenario();
    const records = filesUnder(seedDir)
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n')
      .replace(/,/g, '');
    const figures = new Set<string>();
    for (const item of scenario.agenda) {
      for (const fact of Object.values(item.seatFacts ?? {})) {
        for (const match of fact.match(/\$?\d[\d,]*(?:\.\d+)?%?/g) ?? []) {
          figures.add(match.replace(/,/g, '').replace(/^\$/, ''));
        }
      }
    }
    expect(figures.size).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(records.includes(figure), `seat-fact figure ${figure} is in a record`).toBe(true);
    }
    for (const figure of ['200', '1.60', '300', '420', '9 of 16', '60%', '40%', '3,000', '15',
      '0.50', '240', '120', '5', '2']) {
      expect(records.includes(figure.replace(/,/g, '')), `canon record figure ${figure}`).toBe(true);
    }
  });
});
