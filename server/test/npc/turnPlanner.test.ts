import { describe, expect, it } from 'vitest';
import { MeetingState, type HeardLine, type MeetingTopicInfo } from '../../src/npc/meetingState';
import { describeDecision, next } from '../../src/npc/turnPlanner';

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
      catches: [
        { id: '0:catch:0', attendee: 'Ada', text: 'Calling Ada in means double pay.' },
        { id: '0:catch:1', attendee: 'Bao', text: 'A new till login takes fifteen minutes.' },
      ],
    },
  ];
}

function make(): MeetingState {
  const state = new MeetingState({
    topics: topics(),
    present: ['Ada', 'Bao', 'Sam'],
    host: 'Sam',
    guest: 'Josh',
  });
  state.openTopic('Prep', 0);
  return state;
}

function heard(state: MeetingState, line: Omit<Parameters<MeetingState['heard']>[0], 'at'>, at = 1): HeardLine {
  const recorded = state.heard({ ...line, at });
  if (recorded === undefined) throw new Error(`line ${line.id} was not recorded`);
  return recorded;
}

function makeWith(topic: MeetingTopicInfo, present = ['Ada', 'Bao', 'Sam']): MeetingState {
  const state = new MeetingState({
    topics: [topic],
    present,
    host: 'Sam',
    guest: 'Josh',
  });
  state.openTopic(topic.title, 0);
  return state;
}

describe('turn planner', () => {
  it('opens with the host handing over to the first fact knower', () => {
    const state = make();
    const decision = next(state.view(0), { kind: 'topicOpened' });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Sam', purpose: 'handover' });
    expect(describeDecision(decision)).toBe('Speak Sam (handover)');
  });

  it('lets the guest line\'s own point outrank an older open question to a colleague', () => {
    const state = make();
    heard(state, { id: 'sam-1', speaker: 'Sam', text: 'Ada, who covers the counter?', question: { to: 'Ada', text: 'Ada, who covers the counter?' } });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'What about the till?', proposal: true }, 2);

    const decision = next(state.view(2), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'catch', respondsTo: 'josh-1' });
  });

  it('waits when the open question is addressed to the guest', () => {
    const state = make();
    heard(state, { id: 'sam-1', speaker: 'Sam', text: 'Josh, what is your call?', question: { to: 'Josh', text: 'Josh, what is your call?' } });
    const ada = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'I can cover the first hour.' }, 2);

    const decision = next(state.view(2), { kind: 'heard', line: ada });
    expect(decision).toMatchObject({ kind: 'Wait' });
  });

  it('picks the knower who can answer a later guest point', () => {
    const state = make();
    heard(state, { id: 'josh-0', speaker: 'Josh', text: 'Let us call Auntie Mary in.', proposal: true });
    heard(state, { id: 'ada-1', speaker: 'Ada', text: 'That means double pay for her rest day.' }, 2);
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'What about the till login?', proposal: false }, 3);

    const decision = next(state.view(3), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Bao', purpose: 'answer', respondsTo: 'josh-1' });
  });

  it('asks the colleague holding an unraised catch after the guest first idea', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us call Auntie Mary in.', proposal: true });

    const decision = next(state.view(1), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'catch', respondsTo: 'josh-1' });
  });

  it('waits for the guest once the first idea has had its catch', () => {
    const state = make();
    heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us call Auntie Mary in.', proposal: true });
    const ada = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'That means double pay for her rest day.' }, 2);

    const decision = next(state.view(2), { kind: 'heard', line: ada });
    expect(decision).toMatchObject({ kind: 'Wait' });
    expect(decision.reason).toContain('guest');
  });

  it('invites the guest once after the briefing facts are fully heard', () => {
    const state = make();
    const first = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'The fridge log shows a three hour overnight gap.', factId: '0:0' });

    expect(next(state.view(1), { kind: 'heard', line: first })).toMatchObject({ kind: 'Speak', speaker: 'Bao', purpose: 'brief' });

    const second = heard(state, { id: 'bao-1', speaker: 'Bao', text: 'The till needs a new login before opening.', factId: '0:1' }, 2);
    expect(next(state.view(2), { kind: 'heard', line: second })).toMatchObject({ kind: 'Speak', speaker: 'Sam', purpose: 'invite' });
  });

  it('never lets a partial line answer a question or count as a contribution', () => {
    const state = make();
    heard(state, { id: 'sam-1', speaker: 'Sam', text: 'Josh, what is your call?', question: { to: 'Josh', text: 'Josh, what is your call?' } });
    state.lineStarted({ id: 'josh-partial', speaker: 'Josh', text: 'I would put', at: 2 });
    const partial = state.lineEnded('josh-partial', false, 3);
    if (partial === undefined) throw new Error('partial line missing');

    expect(state.view(3).openQuestion?.to).toBe('Josh');
    expect(next(state.view(3), { kind: 'interrupted', line: partial })).toMatchObject({ kind: 'Wait' });
  });

  it('has nothing new to add and waits for the guest', () => {
    const state = make();
    heard(state, { id: 'ada-1', speaker: 'Ada', text: 'The fridge log shows a three hour overnight gap.', factId: '0:0' });
    heard(state, { id: 'bao-1', speaker: 'Bao', text: 'The till needs a new login before opening.', factId: '0:1' }, 2);
    heard(state, { id: 'sam-1', speaker: 'Sam', text: 'Josh, what is your call?', question: { to: 'Josh', text: 'Josh, what is your call?' } }, 3);
    heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Bao takes the till.', proposal: true }, 4);
    heard(state, { id: 'ada-2', speaker: 'Ada', text: 'That means double pay for her rest day.' }, 5);
    const line = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'Fine.', proposal: false }, 6);

    expect(next(state.view(6), { kind: 'heard', line })).toMatchObject({ kind: 'Wait' });
  });

  it('picks the colleague the guest named before a fact that also matches', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Ada, what about the till login?', proposal: true });

    const decision = next(state.view(1), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'answer', respondsTo: 'josh-1' });
  });

  it('raises the first idea catch before answering a fact that word-overlaps', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'The till login can wait, put someone on the counter.', proposal: true });

    const decision = next(state.view(1), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'catch', respondsTo: 'josh-1' });
  });

  it('never answers a guest line that is only an acknowledgement', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Okay.', proposal: false });

    const decision = next(state.view(1), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Wait' });
  });

  it('falls back to the host clarifying when nothing touches the guest point', () => {
    const state = makeWith({
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      decision: 'what do we do?',
      facts: [{ id: '0:0', text: 'The fridge log shows a three hour overnight gap.', knownBy: ['Ada'] }],
      catches: [],
    });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'The weather looks bad today.', proposal: true });

    const decision = next(state.view(1), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Sam', purpose: 'clarify', respondsTo: 'josh-1' });
  });

  it('gives a guest line at most two AI speakers', () => {
    const state = makeWith({
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      facts: [],
      catches: [
        { id: '0:catch:0', attendee: 'Ada', text: 'Calling Ada in means double pay.' },
        { id: '0:catch:1', attendee: 'Bao', text: 'A new till login takes fifteen minutes.' },
      ],
    });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us call Auntie Mary in.', proposal: true });
    const ada = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'That means double pay for her rest day.' }, 2);
    expect(next(state.view(2), { kind: 'heard', line: ada })).toMatchObject({ kind: 'Wait' });

    const bao = heard(state, { id: 'bao-1', speaker: 'Bao', text: 'The till login takes fifteen minutes.', catch: false }, 3);
    expect(next(state.view(3), { kind: 'heard', line: bao })).toMatchObject({ kind: 'Wait' });
    expect(state.view(3).lines.filter((line) => line.complete && line.speaker !== 'Josh')).toHaveLength(2);
    expect(guest.eventId).toBe('josh-1');
  });

  it('lets a second colleague answer a question the first responder put to them', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Ada, what about the till login?', proposal: true });
    const ada = heard(state, {
      id: 'ada-1', speaker: 'Ada', text: 'Bao, can the till take a new login before opening?',
      question: { to: 'Bao', text: 'Bao, can the till take a new login before opening?' },
    }, 2);

    expect(next(state.view(2), { kind: 'heard', line: ada })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'answer', respondsTo: 'ada-1',
    });
    expect(guest.eventId).toBe('josh-1');
  });

  it('lets the catch owner speak second when the addressed colleague did not raise it', () => {
    const state = makeWith({
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      facts: [],
      catches: [{ id: '0:catch:0', attendee: 'Bao', text: 'A new till login takes fifteen minutes.' }],
    });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Ada, what should we do about the till?', proposal: true });
    expect(next(state.view(1), { kind: 'heard', line: guest })).toMatchObject({
      kind: 'Speak', speaker: 'Ada', purpose: 'answer',
    });
    const ada = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'We can start with drinks only.' }, 2);
    expect(next(state.view(2), { kind: 'heard', line: ada })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'catch', respondsTo: 'josh-1',
    });
  });

  it('lets a second colleague the guest also addressed answer', () => {
    const state = makeWith({
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      facts: [],
      catches: [],
    });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Ada, check the till and tell Bao.', proposal: true });
    expect(next(state.view(1), { kind: 'heard', line: guest })).toMatchObject({
      kind: 'Speak', speaker: 'Ada', purpose: 'answer',
    });
    const ada = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'On it.' }, 2);
    expect(next(state.view(2), { kind: 'heard', line: ada })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'answer', respondsTo: 'josh-1',
    });
  });

  it('names the facts the opening speaker tells, grouping consecutive facts by the same knower', () => {
    const state = new MeetingState({
      topics: [{
        title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', decision: 'how do we cover prep?',
        facts: [
          { id: '0:0', text: 'The fridge was unplugged.', knownBy: ['Ada'] },
          { id: '0:1', text: 'The log shows a gap.', knownBy: ['Ada'] },
          { id: '0:2', text: 'The till needs a login.', knownBy: ['Bao'] },
        ],
        catches: [],
      }],
      present: ['Ada', 'Bao', 'Sam'],
      host: 'Sam',
      guest: 'Josh',
    });
    state.openTopic('Prep', 0);
    const handover = heard(state, { id: 'sam-1', speaker: 'Sam', text: 'Ada, what happened?' });
    const first = next(state.view(1), { kind: 'heard', line: handover });
    expect(first).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'brief', factIds: ['0:0', '0:1'] });

    const told = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'The fridge was unplugged. The log shows a gap.', factIds: ['0:0', '0:1'] }, 2);
    expect(next(state.view(2), { kind: 'heard', line: told })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'brief', factIds: ['0:2'],
    });
  });

  it('invites the guest when the remaining facts have no present knower', () => {
    const state = new MeetingState({
      topics: [{
        title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', decision: 'how do we cover prep?',
        facts: [
          { id: '0:0', text: 'The fridge was unplugged.', knownBy: ['Ada'] },
          { id: '0:1', text: 'A fact only the guest seat knows.', knownBy: ['Wei Ling'] },
        ],
        catches: [],
      }],
      present: ['Ada', 'Bao', 'Sam'],
      host: 'Sam',
      guest: 'Josh',
    });
    state.openTopic('Prep', 0);
    const ada = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'The fridge was unplugged.', factIds: ['0:0'] });
    expect(next(state.view(1), { kind: 'heard', line: ada })).toMatchObject({
      kind: 'Speak', speaker: 'Sam', purpose: 'invite',
    });
  });
});
