import { describe, expect, it } from 'vitest';
import { MeetingState, meetingTopic, type MeetingTopicInfo } from '../../src/npc/meetingState';

function topics(): MeetingTopicInfo[] {
  return [
    {
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      facts: [
        { id: '0:0', text: 'The fridge log shows a three hour overnight gap.', knownBy: ['Ada'] },
        { id: '0:1', text: 'The till needs a new login before opening.', knownBy: ['Bao'] },
      ],
      catches: [{ id: '0:catch:0', attendee: 'Ada', text: 'Calling Ada in means double pay.' }],
    },
    {
      title: 'Service',
      minutes: 5,
      canWait: true,
      deadline: 'after the lunch rush',
      facts: [],
      catches: [],
    },
  ];
}

function make(): MeetingState {
  return new MeetingState({
    topics: topics(),
    present: ['Ada', 'Bao', 'Sam'],
    host: 'Sam',
    guest: 'Josh',
  });
}

describe('meeting state', () => {
  it('keeps a generated but unplayed line out of the ledger', () => {
    const state = make();
    state.openTopic('Prep', 0);
    expect(state.view(0).lastLine).toBeUndefined();
    expect(state.view(0).lastHeard).toBeUndefined();
  });

  it('marks a started line partial until its playback ends, and a partial line does not count', () => {
    const state = make();
    state.openTopic('Prep', 0);
    state.lineStarted({
      id: 'ada-1',
      speaker: 'Ada',
      text: 'The fridge log shows a three hour overnight gap.',
      at: 1,
      factId: '0:0',
    });
    expect(state.view(1).lastLine).toMatchObject({ eventId: 'ada-1', complete: false });
    expect(state.view(1).factsTold).toEqual([]);

    state.lineEnded('ada-1', false, 2);
    expect(state.view(2).lastLine).toMatchObject({ eventId: 'ada-1', complete: false });
    expect(state.view(2).factsTold).toEqual([]);

    state.lineStarted({ id: 'ada-2', speaker: 'Ada', text: 'The fridge log shows a three hour overnight gap.', at: 3, factId: '0:0' });
    state.lineEnded('ada-2', true, 4);
    expect(state.view(4).factsTold).toEqual(['0:0']);
  });

  it('opens one question with from/to/askedAt and lets only its addressee answer it', () => {
    const state = make();
    state.openTopic('Prep', 0);
    const question = state.heard({
      id: 'sam-1',
      speaker: 'Sam',
      text: 'Josh, what is your call?',
      at: 10,
      question: { to: 'Josh', text: 'Josh, what is your call?' },
    });

    expect(question?.complete).toBe(true);
    expect(state.view(10).openQuestion).toEqual({
      from: 'Sam',
      to: 'Josh',
      text: 'Josh, what is your call?',
      askedAt: 10,
      eventId: 'sam-1',
    });

    state.heard({ id: 'ada-1', speaker: 'Ada', text: 'I can cover the first hour.', at: 11 });
    expect(state.view(11).openQuestion?.eventId).toBe('sam-1');

    state.lineStarted({ id: 'josh-partial', speaker: 'Josh', text: 'I would put', at: 12 });
    state.lineEnded('josh-partial', false, 13);
    expect(state.view(13).openQuestion?.eventId).toBe('sam-1');

    state.heard({ id: 'josh-1', speaker: 'Josh', text: 'I would put Bao on the till.', at: 14 });
    expect(state.view(14).openQuestion).toBeUndefined();
  });

  it('answers a question put to a colleague only when that colleague speaks', () => {
    const state = make();
    state.openTopic('Prep', 0);
    state.heard({
      id: 'josh-1',
      speaker: 'Josh',
      text: 'Ada, who covers the counter?',
      at: 1,
      question: { to: 'Ada', text: 'Ada, who covers the counter?' },
    });

    state.heard({ id: 'bao-1', speaker: 'Bao', text: 'I am on the till.', at: 2 });
    expect(state.view(2).openQuestion?.to).toBe('Ada');

    state.heard({ id: 'ada-1', speaker: 'Ada', text: 'I will cover it with Mei.', at: 3 });
    expect(state.view(3).openQuestion).toBeUndefined();
  });

  it('records the guest first idea and whether a real catch has been raised on it', () => {
    const state = make();
    state.openTopic('Prep', 0);
    const idea = state.heard({
      id: 'josh-1',
      speaker: 'Josh',
      text: 'Let us call Auntie Mary in.',
      at: 1,
      proposal: true,
    });

    expect(state.view(1).guestFirstIdea?.eventId).toBe(idea?.eventId);
    expect(state.view(1).guestLaterIdeas).toEqual([]);
    expect(state.view(1).catchRaised).toBe(false);

    state.heard({ id: 'ada-1', speaker: 'Ada', text: 'That means double pay for her rest day.', at: 2 });
    expect(state.view(2).catchRaised).toBe(true);
    expect(state.view(2).catches[0]?.raised).toBe(true);

    state.heard({ id: 'josh-2', speaker: 'Josh', text: 'Then cut the free kopi.', at: 3, proposal: true });
    expect(state.view(3).guestLaterIdeas.map((line) => line.eventId)).toEqual(['josh-2']);
  });

  it('raises only the exact catch a complete line carries, not every catch its owner has', () => {
    const state = new MeetingState({
      topics: [{
        title: 'Prep',
        minutes: 5,
        canWait: false,
        deadline: 'before doors open at 8',
        facts: [],
        catches: [
          { id: '0:catch:0', attendee: 'Ada', text: 'Calling Ada in means double pay.' },
          { id: '0:catch:1', attendee: 'Ada', text: 'The oven needs ten more minutes.' },
        ],
      }],
      present: ['Ada', 'Bao', 'Sam'],
      host: 'Sam',
      guest: 'Josh',
    });
    state.openTopic('Prep', 0);
    state.heard({ id: 'josh-1', speaker: 'Josh', text: 'Let us call Ada in.', at: 1, proposal: true });

    state.heard({ id: 'ada-1', speaker: 'Ada', text: 'That could work.', at: 2 });
    expect(state.view(2).catchRaised).toBe(false);
    expect(state.view(2).catches.every((entry) => !entry.raised)).toBe(true);

    state.lineStarted({ id: 'ada-2', speaker: 'Ada', text: 'Calling Ada in means double pay.', at: 3, catchId: '0:catch:0' });
    expect(state.view(3).catches[0]?.raised).toBe(false);
    state.lineEnded('ada-2', true, 4);
    expect(state.view(4).catches[0]?.raised).toBe(true);
    expect(state.view(4).catches[1]?.raised).toBe(false);
    expect(state.view(4).catchRaised).toBe(true);
  });

  it('resets the view on a topic change and restores the earlier ledger when it reopens', () => {
    const state = make();
    state.openTopic('Prep', 0);
    state.heard({ id: 'ada-1', speaker: 'Ada', text: 'The fridge log shows a three hour overnight gap.', at: 1 });
    state.heard({ id: 'josh-1', speaker: 'Josh', text: 'What about the till?', at: 2, proposal: true });

    expect(state.openTopic('Service', 10)).toBe(true);
    expect(state.view(10).lastLine).toBeUndefined();
    expect(state.view(10).guestFirstIdea).toBeUndefined();

    expect(state.openTopic('Prep', 20)).toBe(true);
    expect(state.view(20).lastHeard?.eventId).toBe('josh-1');
    expect(state.view(20).guestFirstIdea?.eventId).toBe('josh-1');
  });

  it('carries the topic deadline and remaining time', () => {
    const state = make();
    state.openTopic('Prep', 1_000);
    expect(state.view(61_000)).toMatchObject({
      canWait: false,
      deadline: 'before doors open at 8',
      remainingMs: 240_000,
    });
  });

  it('maps agenda items into topics with fact ids and catch owners', () => {
    const topic = meetingTopic({
      title: 'Prep',
      minutes: 5,
      ownerRole: 'chef',
      canWait: false,
      deadline: 'before service',
      briefing: [{ text: 'The oven is cold.', knownBy: [{ attendee: 'Ada', why: 'you lit it' }] }],
      discussion: {
        openingViews: [],
        tradeOffs: [
          { attendee: 'Ada', role: 'chef', tradeOff: 'The oven needs ten minutes.', question: 'When do we start?' },
        ],
      },
    }, 2);

    expect(topic.facts).toEqual([{ id: '2:0', text: 'The oven is cold.', knownBy: ['Ada'] }]);
    expect(topic.catches).toEqual([{ id: '2:catch:0', attendee: 'Ada', text: 'The oven needs ten minutes.' }]);
  });
});
