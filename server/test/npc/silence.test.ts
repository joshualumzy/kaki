import { describe, expect, it } from 'vitest';
import { spokenAgendaName } from '../../src/host/opening';
import { loadScenario } from '../../src/core/loadScenario';
import { silenceCheckInLine, silenceCheckInNote, silenceColleagueNote } from '../../src/npc/silence';

describe('silence nudge stage 1', () => {
  it('names the guest and never mentions options', async () => {
    const scenario = await loadScenario('kopitiam');
    for (const item of scenario.agenda) {
      const topic = spokenAgendaName(scenario, item.title);
      for (let seed = 0; seed < 10; seed += 1) {
        const line = silenceCheckInLine('Josh', topic, seed);
        expect(line, line).toContain('Josh');
        expect(line, line).not.toMatch(/option/i);
      }
      for (const settled of [false, true]) {
        const note = silenceCheckInNote('Sam', 'Josh', topic, settled);
        expect(note, note).toContain('Josh');
        expect(note, note).not.toMatch(/option/i);
      }
    }
  });
});

describe('silence nudge stage 2', () => {
  it('asks the owner for one helpful sentence, never a list to pick from', async () => {
    const scenario = await loadScenario('kopitiam');
    for (const item of scenario.agenda) {
      const note = silenceColleagueNote('Mei', 'Josh', item.title, item.decision);
      expect(note, note).toContain('Mei');
      expect(note, note).toContain('Josh');
      expect(note, note).toMatch(/ONE short spoken sentence/i);
      expect(note, note).not.toMatch(/option|direction|choice/i);
    }
  });
});
