import { describe, expect, it } from 'vitest';
import { liveNextItemLine, liveOpeningLine, spokenAgendaName } from '../../src/host/opening';
import { testScenario } from '../fixtures/scenario';

describe('liveNextItemLine', () => {
  it('announces the next item while leaving its briefing to the chosen opening style', () => {
    const scenario = { ...testScenario, agenda: [{ ...testScenario.agenda[0]!, briefing: 'Fresh stock arrived late.' }] };
    const line = liveNextItemLine(scenario, 'Prep', { name: 'Visitor', seat: 'Bao' });
    expect(line).not.toContain('Fresh stock arrived late.');
    expect(line).toBe('Next up, Prep.');
    expect(liveNextItemLine(scenario, 'Prep')).toBe(line);
  });

  it('uses the scenario\'s short spoken name for the next item', () => {
    const scenario = {
      ...testScenario,
      agenda: [{ ...testScenario.agenda[0]!, title: 'One counter staff short for the opening rush', spoken: 'the staffing gap' }],
    };
    expect(liveNextItemLine(scenario, 'One counter staff short for the opening rush'))
      .toBe('Next up, the staffing gap.');
  });

  it('speaks small agenda counts as words in the welcome', () => {
    const scenario = {
      ...testScenario,
      situation: 'Lunch service starts in ten minutes.',
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' as const }],
    };
    const line = liveOpeningLine(scenario);
    expect(line).toContain("We've got two quick issues");
    expect(line).toContain("Let's start with Prep.");
  });

  it('ends the situation sentence before saying what the meeting has to settle', () => {
    const scenario = {
      ...testScenario,
      situation: "It's 7 AM on opening day at our refurbished Raffles Place flagship, and doors open at 8.",
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' as const }],
    };
    const line = liveOpeningLine(scenario);
    expect(line).toContain("doors open at 8. We've got two quick issues to settle today.");
    expect(line).not.toContain('doors open at 8, and we');
  });

  it('tells the visitor once that they make the calls, using the host brief', () => {
    const scenario = { ...testScenario, hostBrief: { goal: 'Settle today with the visitor as opening-day lead.', decision: 'One call per item.' } };
    const line = liveOpeningLine(scenario, { name: 'Visitor', seat: 'Bao' });
    expect(line).toContain("You're opening-day lead, so the calls are yours.");
    expect(line.match(/calls are yours/g)).toHaveLength(1);
    expect(line).not.toContain('which Ada is leading');
  });
});

describe('spokenAgendaName', () => {
  it('uses the short spoken name when set, and the cleaned title otherwise', () => {
    const scenario = {
      ...testScenario,
      agenda: [
        { ...testScenario.agenda[0]!, title: 'Food safety complaint before the 9 AM inspection', spoken: 'the food safety complaint' },
        { title: 'Old regulars & the new kopi prices', minutes: 5, ownerRole: 'chef' as const },
      ],
    };
    expect(spokenAgendaName(scenario, 'Food safety complaint before the 9 AM inspection')).toBe('the food safety complaint');
    expect(spokenAgendaName(scenario, 'Old regulars & the new kopi prices')).toBe('Old regulars and the new kopi prices');
    expect(spokenAgendaName(scenario, 'the food safety complaint')).toBe('the food safety complaint');
  });
});
