import { describe, expect, it } from 'vitest';
import { liveNextItemLine } from '../../src/host/opening';
import { testScenario } from '../fixtures/scenario';

describe('liveNextItemLine', () => {
  it('includes the topic briefing when a colleague owns the item', () => {
    const scenario = { ...testScenario, agenda: [{ ...testScenario.agenda[0]!, briefing: 'Fresh stock arrived late.' }] };
    const line = liveNextItemLine(scenario, 'Prep', { name: 'Visitor', seat: 'Bao' });
    expect(line).toContain('Fresh stock arrived late.');
    expect(line).toContain('Ada');
  });
});
