import { describe, expect, it } from 'vitest';
import { liveNextItemLine, liveOpeningLine } from '../../src/host/opening';
import { testScenario } from '../fixtures/scenario';

describe('liveNextItemLine', () => {
  it('announces the next item while leaving its briefing to the chosen opening style', () => {
    const scenario = { ...testScenario, agenda: [{ ...testScenario.agenda[0]!, briefing: 'Fresh stock arrived late.' }] };
    const line = liveNextItemLine(scenario, 'Prep', { name: 'Visitor', seat: 'Bao' });
    expect(line).not.toContain('Fresh stock arrived late.');
    expect(line).toBe('Alright team, next is Prep.');
    expect(liveNextItemLine(scenario, 'Prep')).toBe(line);
  });

  it('tells the visitor once that they make the calls, using the host brief', () => {
    const scenario = { ...testScenario, hostBrief: { goal: 'Settle today with the visitor as opening-day lead.', decision: 'One call per item.' } };
    const line = liveOpeningLine(scenario, { name: 'Visitor', seat: 'Bao' });
    expect(line).toContain("You're opening-day lead, so the calls are yours.");
    expect(line.match(/calls are yours/g)).toHaveLength(1);
    expect(line).not.toContain('which Ada is leading');
  });
});
