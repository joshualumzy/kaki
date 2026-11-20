import { describe, expect, it } from 'vitest';
import { loadScenario } from '../../src/core/loadScenario';
import { buildSttPhrases } from '../../src/npc/sttPhrases';
import { runnerSnapshot } from '../fixtures/runnerSnapshot';

const pack = await loadScenario('kopitiam');

const packVocabulary = pack.vocabulary ?? [];
const packCastNames = (pack.npcs ?? []).map((npc) => npc.attendee);
const packAttendeeNames = pack.attendees.map((attendee) => attendee.name);

const team = {
  ...pack,
  organisation: 'Ana and Ben LLP',
  attendees: [
    { name: 'Ana', role: 'general_manager', displayName: 'Ana' },
    { name: 'Ben', role: 'tech_pos_lead', displayName: 'Ben' },
  ],
  npcs: [],
};

const lower = (phrases: readonly string[]): Set<string> =>
  new Set(phrases.map((phrase) => phrase.trim().toLowerCase()));

describe('buildSttPhrases', () => {
  it('leans a team meeting towards its own people and the room, never the pack cast or vocabulary', () => {
    const phrases = buildSttPhrases({
      startupPack: pack,
      meeting: runnerSnapshot(team, { kind: 'real' }),
      joinedNames: ['Cy (Designer)'],
    });

    expect(phrases).toEqual(expect.arrayContaining(['Ana', 'Ben', 'Cy', 'Ana and Ben LLP']));
    expect(phrases).not.toContain('Cy (Designer)');
    expect(phrases).not.toContain(pack.organisation);
    for (const word of packVocabulary) expect(phrases).not.toContain(word);
    for (const name of packCastNames) expect(phrases).not.toContain(name);
  });

  it('gives a practice meeting the pack vocabulary, its cast and the people in the room', () => {
    const phrases = buildSttPhrases({
      startupPack: pack,
      meeting: runnerSnapshot(pack, { kind: 'practice' }),
      joinedNames: ['Dee (Host)'],
    });

    expect(phrases).toEqual(
      expect.arrayContaining([...packVocabulary, ...packCastNames, ...packAttendeeNames, 'Dee', pack.organisation]),
    );
    expect(phrases).not.toContain('Dee (Host)');
  });

  it('falls back to the startup pack before any meeting is active', () => {
    const phrases = buildSttPhrases({ startupPack: pack });

    expect(lower(phrases)).toEqual(
      lower([...packVocabulary, ...packAttendeeNames, pack.organisation ?? '']),
    );
  });

  it('removes blank phrases and repeats, and strips a role suffix from a joined name', () => {
    const phrases = buildSttPhrases({
      startupPack: pack,
      meeting: runnerSnapshot(team, { kind: 'real' }),
      joinedNames: [' Ana ', '', '   ', 'ana', 'Ben (Chef)'],
    });

    expect(phrases.filter((phrase) => phrase.toLowerCase() === 'ana')).toEqual(['Ana']);
    expect(phrases).toContain('Ben');
    expect(phrases).not.toContain('');
    expect(phrases.some((phrase) => phrase.includes('(Chef)'))).toBe(false);
  });
});
