import { describe, expect, it } from 'vitest';
import { MeetingMemory } from '../../src/npc/meetingMemory';
import { testScenario } from '../fixtures/scenario';

describe('meeting memory', () => {
  it('replaces decisions, records a new spoken number, and clears on reset', () => {
    const logs: string[] = [];
    const snapshots: unknown[] = [];
    const memory = new MeetingMemory(testScenario, (entries) => snapshots.push(entries), (line) => logs.push(line));
    memory.decision('Prep', 'Use the original plan.');
    memory.invented('Prep', ['The supplier needs 20 minutes.']);
    memory.spoken('Prep', 'It will cost $37.');
    memory.spoken('Prep', 'It will cost $37.');
    memory.decision('Prep', 'Use the revised plan.');
    expect(memory.snapshot().filter((entry) => entry.kind === 'decision')).toEqual([
      { kind: 'decision', item: 'Prep', text: 'Use the revised plan.' },
    ]);
    expect(memory.snapshot().filter((entry) => entry.kind === 'saidAloud')).toHaveLength(1);
    expect(logs).toEqual([expect.stringContaining('[memory] invented Prep: The supplier needs 20 minutes.'), expect.stringContaining('[memory] auto-added')]);
    expect(snapshots.length).toBeGreaterThan(0);
    memory.markReopened('Prep');
    expect(memory.wasReopened('Prep')).toBe(true);
    memory.reset();
    expect(memory.snapshot()).toEqual([]);
    expect(memory.wasReopened('Prep')).toBe(false);
  });

  it('records a spoken number that appears only as numeric scenario config', () => {
    const memory = new MeetingMemory(testScenario, () => undefined, () => undefined);
    memory.spoken('Prep', 'We need 5 days.');
    expect(memory.snapshot()).toContainEqual({ kind: 'saidAloud', item: 'Prep', text: 'said aloud: We need 5 days.' });
  });

  it('does not record a spoken number that already appears in scenario text', () => {
    const withText = {
      ...testScenario,
      agenda: [{
        ...testScenario.agenda[0]!,
        briefing: [{ text: 'Help takes 12 minutes.', knownBy: [{ attendee: 'Ada', why: 'you timed it' }] }],
      }],
    };
    const memory = new MeetingMemory(withText, () => undefined, () => undefined);
    memory.spoken('Prep', 'Help takes 12 minutes.');
    expect(memory.snapshot()).toEqual([]);
  });

  it('drops the oldest invented detail first at the cap and keeps decisions', () => {
    const memory = new MeetingMemory(testScenario, () => undefined, () => undefined);
    memory.decision('Prep', 'Keep this call.');
    for (let i = 0; i < 40; i += 1) memory.invented('Prep', [`Detail ${i}`]);
    expect(memory.snapshot()).toHaveLength(40);
    expect(memory.snapshot()).toContainEqual({ kind: 'decision', item: 'Prep', text: 'Keep this call.' });
    expect(memory.snapshot()).not.toContainEqual({ kind: 'invented', item: 'Prep', text: 'Detail 0' });
  });
});
