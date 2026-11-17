import { describe, expect, it } from 'vitest';
import { liveNextItemLine, liveOpeningLine, liveWrapUpLine, spokenAgendaName, topicSpeaker } from '../../src/host/opening';
import { loadScenario } from '../../src/loadScenario';
import { testScenario } from '../fixtures/scenario';

describe('liveOpeningLine', () => {
  it('opens the shipped Kopitiam meeting with each colleague\'s job and the right speaker', async () => {
    const scenario = await loadScenario('kopitiam');
    const line = liveOpeningLine(scenario, { name: 'Josh', seat: 'Wei Ling' });
    expect(line.split(/(?<=[.!?])\s+/)).toHaveLength(6);
    expect(line).toContain("You're opening-day lead, so the calls are yours.");
    expect(line).toContain("I'm Sam, and with us are Arjun on tills and tech, Mei on the menu and the store, and Daniel on marketing.");
    expect(line).not.toContain('Wei Ling');
    expect(line).toContain('our Operations Director');
    expect(line).toContain('doors open at 8');
    expect(line).toContain("First up, the staffing gap. Mei, you've been setting up the counter, what happened?");
  });

  it('announces the next item and hands over without reading its briefing', () => {
    const scenario = {
      ...testScenario,
      agenda: [{
        ...testScenario.agenda[0]!,
        briefing: [{ text: 'Fresh stock arrived late.', knownBy: [{ attendee: 'Ada', why: 'you signed for the delivery' }] }],
      }],
    };
    const line = liveNextItemLine(scenario, 'Prep', { name: 'Visitor', seat: 'Bao' });
    expect(line).not.toContain('Fresh stock arrived late.');
    expect(line).toBe('Next up, Prep. Ada, you signed for the delivery, what happened?');
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
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' }],
    };
    expect(liveNextItemLine(scenario, 'Service')).toBe("Right, let's move on to Service. Bao, over to you.");
    expect(liveWrapUpLine(scenario, 'Prep')).toBe("Let's leave Prep there.");
    expect(liveWrapUpLine(scenario, 'Service')).toBe("Good, that's Service sorted.");
  });

  it('ends on the topic without inviting the visitor when a colleague brief follows and no briefing fact is given', () => {
    const scenario = {
      ...testScenario,
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' }],
    };
    const line = liveNextItemLine(scenario, 'Service', { name: 'Visitor', seat: 'Bao' }, true);
    expect(line).toBe("Right, let's move on to Service.");
    expect(line).not.toContain('over to you');
  });

  it('keeps the welcome to short spoken sentences', () => {
    const scenario = {
      ...testScenario,
      situation: 'Lunch service starts in ten minutes.',
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' }],
    };
    const line = liveOpeningLine(scenario);
    expect(line).toContain('First up, Prep.');
    expect(line).not.toContain('two quick issues');
    expect(line.split(/(?<=[.!?])\s+/)).toHaveLength(4);
  });

  it('ends the situation sentence before saying what the meeting has to settle', () => {
    const scenario = {
      ...testScenario,
      situation: "It's 7 AM on opening day at our refurbished Raffles Place flagship, and doors open at 8.",
      agenda: [testScenario.agenda[0]!, { title: 'Service', minutes: 5, ownerRole: 'cashier' }],
    };
    const line = liveOpeningLine(scenario);
    expect(line).toContain('doors open at 8. First up, Prep.');
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

  it('names the colleagues once and uses their plain job words', () => {
    const scenario = {
      ...testScenario,
      situation: 'Lunch service starts in ten minutes.',
      roles: [
        ...testScenario.roles,
        { id: 'manager', label: 'General Manager', facilitator: true },
        { id: 'runner', label: 'Floor Runner' },
      ],
      attendees: [
        ...testScenario.attendees,
        { name: 'Sam', role: 'manager', zoomDisplayName: 'Sam', spokenJob: 'who runs the meeting' },
        { name: 'Mei', role: 'runner', zoomDisplayName: 'Mei', spokenJob: 'on the floor' },
      ],
    };
    const line = liveOpeningLine(scenario, { name: 'Visitor', seat: 'Bao' });
    expect(line).toContain("I'm Sam, and with us are Ada and Mei on the floor.");
    expect(line).not.toContain('General Manager');
    expect(line).not.toContain('Sam is our');
    expect(line).not.toContain('Bao is our');
    expect(line.indexOf('Ada')).toBeLessThan(line.indexOf('Lunch service starts'));
    expect(line.split(/(?<=[.!?])\s+/)).toHaveLength(4);
  });
});

describe('topic handover', () => {
  const factScenario = {
    ...testScenario,
    roles: [...testScenario.roles, { id: 'manager', label: 'Manager', facilitator: true }],
    attendees: [...testScenario.attendees, { name: 'Sam', role: 'manager', zoomDisplayName: 'Sam' }],
    agenda: [{
      ...testScenario.agenda[0]!,
      spoken: 'the prep gap',
      briefing: [{
        text: 'The stock arrived late.',
        knownBy: [
          { attendee: 'Ada', why: 'you saw the stock arrive' },
          { attendee: 'Bao', why: 'you counted the trays' },
        ],
      }],
    }],
  };

  it('names the first fact speaker with the reason they know', () => {
    expect(liveNextItemLine(factScenario, 'Prep'))
      .toBe('Next up, the prep gap. Ada, you saw the stock arrive, what happened?');
    expect(topicSpeaker(factScenario, 'Prep')).toEqual({ attendee: 'Ada', why: 'you saw the stock arrive' });
  });

  it('skips a guest sitting in the speaker\'s seat and uses the next knower', () => {
    expect(liveNextItemLine(factScenario, 'Prep', { name: 'Visitor', seat: 'Ada' }))
      .toBe('Next up, the prep gap. Bao, you counted the trays, what happened?');
  });

  it('falls back and logs when the item has no briefing fact', () => {
    const logs: string[] = [];
    const noBriefing = {
      ...factScenario,
      agenda: [{ ...factScenario.agenda[0]!, briefing: undefined }],
    };
    expect(liveNextItemLine(noBriefing, 'Prep', { name: 'Visitor', seat: 'Bao' }, false, (line) => logs.push(line)))
      .toBe('Next up, the prep gap. Ada, over to you.');
    expect(logs).toEqual([expect.stringContaining('no speaker')]);
  });

  it('hands over the first fact that still has a present knower', () => {
    const scenario = {
      ...factScenario,
      agenda: [{
        ...factScenario.agenda[0]!,
        briefing: [
          { text: 'The stock arrived late.', knownBy: [{ attendee: 'Bao', why: 'you counted the trays' }] },
          { text: 'The oven is cold.', knownBy: [{ attendee: 'Ada', why: 'you lit the oven' }] },
        ],
      }],
    };
    expect(topicSpeaker(scenario, 'Prep', { visitorSeat: 'Bao' })).toEqual({ attendee: 'Ada', why: 'you lit the oven' });
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
