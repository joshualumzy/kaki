import { describe, expect, it } from 'vitest';
import { liveNextItemLine, liveOpeningLine, liveWrapUpLine, spokenAgendaName } from '../../src/host/opening';
import { loadScenario } from '../../src/loadScenario';
import { testScenario } from '../fixtures/scenario';

describe('liveNextItemLine', () => {
  it('keeps the shipped Kopitiam welcome within four short lines', async () => {
    const scenario = await loadScenario('kopitiam');
    const line = liveOpeningLine(scenario, { name: 'Visitor', seat: 'Wei Ling' });
    expect(line.split(/(?<=[.!?])\s+/)).toHaveLength(4);
    expect(line.split(/\s+/).length).toBeLessThanOrEqual(55);
    expect(line).toContain("You're opening-day lead, so the calls are yours.");
    for (const name of ['Sam', 'Mei', 'Arjun', 'Daniel']) expect(line).toContain(name);
    expect(line).toContain('our Operations Director');
    expect(line).toContain('First, the staffing gap.');
  });
  it('announces the next item while leaving its briefing to the chosen opening style', () => {
    const scenario = { ...testScenario, agenda: [{ ...testScenario.agenda[0]!, briefing: 'Fresh stock arrived late.' }] };
    const line = liveNextItemLine(scenario, 'Prep', { name: 'Visitor', seat: 'Bao' });
    expect(line).not.toContain('Fresh stock arrived late.');
    expect(line).toBe('Next up, Prep. Ada, over to you.');
    expect(liveNextItemLine(scenario, 'Prep')).toBe(line);
  });

  it('uses the scenario\'s short spoken name for the next item', () => {
    const scenario = {
      ...testScenario,
      agenda: [{ ...testScenario.agenda[0]!, title: 'One counter staff short for the opening rush', spoken: 'the staffing gap' }],
    };
    expect(liveNextItemLine(scenario, 'One counter staff short for the opening rush'))
      .toBe('Next up, the staffing gap. Ada, over to you.');
  });

  it('varies the next-item wording by topic and hands over to that topic\'s lead', () => {
    const scenario = {
      ...testScenario,
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' as const }],
    };
    expect(liveNextItemLine(scenario, 'Service')).toBe("Right, let's move on to Service. Bao, over to you.");
    expect(liveWrapUpLine(scenario, 'Prep')).toBe("Let's leave Prep there.");
    expect(liveWrapUpLine(scenario, 'Service')).toBe("Good, that's Service sorted.");
  });

  it('ends on the topic without inviting the visitor when a colleague brief follows', () => {
    const scenario = {
      ...testScenario,
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' as const }],
    };
    const line = liveNextItemLine(scenario, 'Service', { name: 'Visitor', seat: 'Bao' }, true);
    expect(line).toBe("Right, let's move on to Service.");
    expect(line).not.toContain('over to you');
  });

  it('keeps the welcome to three short spoken sentences', () => {
    const scenario = {
      ...testScenario,
      situation: 'Lunch service starts in ten minutes.',
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' as const }],
    };
    const line = liveOpeningLine(scenario);
    expect(line).toContain('First, Prep.');
    expect(line).not.toContain('two quick issues');
    expect(line.split(/(?<=[.!?])\s+/)).toHaveLength(3);
  });

  it('ends the situation sentence before saying what the meeting has to settle', () => {
    const scenario = {
      ...testScenario,
      situation: "It's 7 AM on opening day at our refurbished Raffles Place flagship, and doors open at 8.",
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' as const }],
    };
    const line = liveOpeningLine(scenario);
    expect(line).toContain('doors open at 8. First, Prep.');
    expect(line).not.toContain('doors open at 8, and we');
  });

  it('tells the visitor the calls are theirs without reading the rest of the host brief', () => {
    const scenario = { ...testScenario, hostBrief: { goal: 'Settle today with the visitor as opening-day lead.', decision: 'One call per item.' } };
    const line = liveOpeningLine(scenario, { name: 'Visitor', seat: 'Bao' });
    expect(line).toContain('Visitor, our Cashier');
    expect(line).toContain("You're opening-day lead, so the calls are yours.");
    expect(line).not.toContain('One call per item');
    expect(line).not.toContain('which Ada is leading');
  });

  it('names the colleagues once without reading every job title', () => {
    const scenario = {
      ...testScenario,
      situation: 'Lunch service starts in ten minutes.',
      roles: [
        ...testScenario.roles,
        { id: 'manager' as const, label: 'General Manager', facilitator: true },
        { id: 'runner' as const, label: 'Floor Runner' },
      ],
      attendees: [
        ...testScenario.attendees,
        { name: 'Sam', role: 'manager' as const, zoomDisplayName: 'Sam' },
        { name: 'Mei', role: 'runner' as const, zoomDisplayName: 'Mei' },
      ],
    };
    const line = liveOpeningLine(scenario, { name: 'Visitor', seat: 'Bao' });
    expect(line).toContain("I'm Sam, with Ada and Mei here.");
    expect(line).not.toContain('General Manager');
    expect(line).not.toContain('Sam is our');
    expect(line).not.toContain('Bao is our');
    expect(line.indexOf('Ada')).toBeLessThan(line.indexOf('Lunch service starts'));
    expect(line.split(/(?<=[.!?])\s+/)).toHaveLength(3);
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
