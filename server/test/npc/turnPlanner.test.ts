import { describe, expect, it } from 'vitest';
import { MeetingState, type HeardLine, type MeetingTopicInfo } from '../../src/npc/meetingState';
import { describeDecision, mergedReadiness, next, readinessMet } from '../../src/npc/turnPlanner';
import { readGuestLine, type GuestLineKind, type GuestReading } from '../../src/npc/guestReader';

function topics(overrides: Partial<MeetingTopicInfo> = {}): MeetingTopicInfo[] {
  return [
    {
      title: 'Prep',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      decision: 'how do we cover the counter?',
      owner: 'Ada',
      facts: [
        { id: '0:0', text: 'The fridge log shows a three hour overnight gap.', knownBy: ['Ada'] },
        { id: '0:1', text: 'The till needs a new login before opening.', knownBy: ['Bao'] },
      ],
      catches: [
        { id: '0:catch:0', attendee: 'Ada', text: 'Calling Ada in means double pay.' },
        { id: '0:catch:1', attendee: 'Bao', text: 'A new till login takes fifteen minutes.' },
      ],
      ...overrides,
    },
  ];
}

function make(topic: Partial<MeetingTopicInfo> = {}): MeetingState {
  const state = new MeetingState({
    topics: topics(topic),
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

const off = { covered: false } as const;

function reading(overrides: Partial<GuestReading> = {}): GuestReading {
  return {
    kind: 'idea',
    answersOpenQuestion: false,
    relevantFactIds: [],
    relevantCatchIds: [],
    readiness: { action: off, catchAddressed: off, practical: off },
    ...overrides,
  };
}

function record(state: MeetingState, eventId: string, value: GuestReading): GuestReading {
  state.recordReading(eventId, value);
  return value;
}

describe('turn planner', () => {
  it('opens with the host handing over to the first fact knower', () => {
    const state = make();
    const decision = next(state.view(0), { kind: 'topicOpened' });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Sam', purpose: 'handover' });
    expect(describeDecision(decision)).toBe('Speak Sam (handover)');
  });

  it('lets the reading\'s addressee answer, not a word-list match', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us call Auntie Mary in.' });
    const value = record(state, 'josh-1', reading({ kind: 'idea', addressee: 'Ada' }));

    const decision = next(state.view(1), { kind: 'heard', line: guest, reading: value });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'answer', respondsTo: 'josh-1' });
  });

  it('drops an addressee who is not in the room', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Ask Arjun about it.' });
    const value = record(state, 'josh-1', reading({ kind: 'question' }));

    const decision = next(state.view(1), { kind: 'heard', line: guest, reading: value });
    expect(decision).not.toMatchObject({ speaker: 'Arjun' });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Ada' });
  });

  it('asks the first idea\'s requested catch owner when a catch is still unraised', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us call Auntie Mary in.' });
    const value = record(state, 'josh-1', reading({ kind: 'idea', relevantCatchIds: ['0:catch:1'] }));

    const decision = next(state.view(1), { kind: 'heard', line: guest, reading: value });
    expect(decision).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'catch', catchId: '0:catch:1', respondsTo: 'josh-1',
    });
  });

  it('takes the first idea\'s unraised catch before it can be ready', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Call Auntie Mary in, Bao covers the till from 8.' });
    record(state, 'josh-1', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: { covered: true, evidence: 'Call Auntie Mary in' },
        practical: { covered: true, evidence: 'Bao covers the till from 8' },
      },
    }));

    expect(readinessMet(state.view(1))).toBe(false);
    expect(next(state.view(1), { kind: 'heard', line: guest })).toMatchObject({ kind: 'Speak', purpose: 'catch' });
  });

  it('sends a question with relevant facts to a knower of that fact', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Can the till take a new login?' });
    const value = record(state, 'josh-1', reading({ kind: 'question', relevantFactIds: ['0:1'] }));

    expect(next(state.view(1), { kind: 'heard', line: guest, reading: value })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'answer', factIds: ['0:1'], respondsTo: 'josh-1',
    });
  });

  it('answers a bare agree from the open question as an answer, not filler', () => {
    const state = make();
    heard(state, {
      id: 'sam-1', speaker: 'Sam', text: 'Josh, what is your call?',
      question: { to: 'Josh', text: 'Josh, what is your call?' },
    });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Yes.' }, 2);
    const value = record(state, 'josh-1', reading({
      kind: 'agree',
      answersOpenQuestion: true,
      relevantFactIds: ['0:1'],
    }));

    expect(next(state.view(2), { kind: 'heard', line: guest, reading: value })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'answer', respondsTo: 'josh-1',
    });
  });

  it('gives a confused guest a help line instead of silence', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'not sure what you mean' });
    const value = record(state, 'josh-1', reading({ kind: 'unsure', relevantFactIds: ['0:1'] }));

    expect(next(state.view(1), { kind: 'heard', line: guest, reading: value })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'clarify', respondsTo: 'josh-1',
    });
  });

  it('falls back to Sam for a confused guest when no fact helps', () => {
    const state = make({ catches: [] });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'idk' });
    const value = record(state, 'josh-1', reading({ kind: 'unsure' }));

    expect(next(state.view(1), { kind: 'heard', line: guest, reading: value })).toMatchObject({
      kind: 'Speak', speaker: 'Sam', purpose: 'clarify',
    });
  });

  it('checks once on noise, then waits on a second noise in a row', () => {
    const state = make();
    const first = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'testing' });
    record(state, 'josh-1', reading({ kind: 'noise' }));
    expect(next(state.view(1), { kind: 'heard', line: first })).toMatchObject({
      kind: 'Speak', speaker: 'Sam', purpose: 'clarify',
    });

    const second = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'can you hear me' }, 2);
    record(state, 'josh-2', reading({ kind: 'noise' }));
    expect(next(state.view(2), { kind: 'heard', line: second })).toMatchObject({ kind: 'Wait' });
  });

  it('steers an off-topic guest back to the decision', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Did you watch the match?' });
    const value = record(state, 'josh-1', reading({ kind: 'off_topic' }));

    expect(next(state.view(1), { kind: 'heard', line: guest, reading: value })).toMatchObject({
      kind: 'Speak', speaker: 'Sam', purpose: 'clarify',
    });
  });

  it('confirms once every slot is covered, the catch is raised, and no guest question is open', () => {
    const state = make();
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Call Auntie Mary in, Bao covers the till from 8.' });
    record(state, 'josh-1', reading({
      kind: 'answer',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: { covered: true, evidence: 'Call Auntie Mary in' },
        practical: { covered: true, evidence: 'Bao covers the till from 8' },
      },
    }));

    expect(readinessMet(state.view(1))).toBe(true);
    expect(next(state.view(1), { kind: 'heard', line: guest })).toMatchObject({ kind: 'ConfirmDecision' });
  });

  it('keeps a slot covered across readings', () => {
    const state = make();
    const first = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Call Auntie Mary in.' });
    record(state, 'josh-1', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: off,
        practical: off,
      },
    }));
    next(state.view(1), { kind: 'heard', line: first });
    heard(state, { id: 'josh-2', speaker: 'Josh', text: 'Bao covers the till from 8.' }, 2);
    record(state, 'josh-2', reading({
      kind: 'answer',
      readiness: {
        action: off,
        catchAddressed: { covered: true, evidence: 'Bao covers the till from 8' },
        practical: { covered: true, evidence: 'Bao covers the till from 8' },
      },
    }));

    expect(mergedReadiness(state.view(2))).toEqual({
      action: { covered: true, evidence: 'Call Auntie Mary in' },
      catchAddressed: { covered: true, evidence: 'Bao covers the till from 8' },
      practical: { covered: true, evidence: 'Bao covers the till from 8' },
    });
  });

  it('does not confirm while a question to the guest is still open', () => {
    const state = make();
    heard(state, {
      id: 'sam-1', speaker: 'Sam', text: 'Josh, is that the call?',
      question: { to: 'Josh', text: 'Josh, is that the call?' },
    });
    heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Call Auntie Mary in, Bao covers the till from 8.' }, 2);
    record(state, 'josh-1', reading({
      kind: 'answer',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: { covered: true, evidence: 'Call Auntie Mary in' },
        practical: { covered: true, evidence: 'Bao covers the till from 8' },
      },
    }));

    expect(readinessMet(state.view(2))).toBe(false);
  });

  it('confirms the guest\'s answer even when the reader left answersOpenQuestion out (seen live)', async () => {
    const state = make({ catches: [] });
    heard(state, {
      id: 'sam-1', speaker: 'Sam', text: 'Where is your head at on the regulars and the price?',
      question: { to: 'Josh', text: 'Where is your head at on the regulars and the price?' },
    });
    const guest = heard(state, {
      id: 'josh-1', speaker: 'Josh',
      text: 'Uncle Lim vouches, small cup at old price, floor team knows the rest.',
    }, 2);
    // The exact reading the school model returned: a covered action, with answersOpenQuestion omitted.
    const stream = (): AsyncIterable<string> => (async function* () {
      yield JSON.stringify({
        kind: 'idea',
        relevantFactIds: [],
        relevantCatchIds: [],
        readiness: {
          action: { covered: true, evidence: 'small cup at old price' },
          catchAddressed: { covered: false },
          practical: { covered: false },
        },
      });
    })();
    const value = await readGuestLine({
      topic: {
        title: 'Prep', decision: 'how do we cover the counter?', canWait: false, deadline: 'before doors open at 8',
      },
      openQuestion: { from: 'Sam', to: 'Josh', text: 'Where is your head at on the regulars and the price?' },
      guest: 'Josh',
      guestLines: [guest.text],
      colleagues: [
        { name: 'Ada', facts: [], catches: [] },
        { name: 'Bao', facts: [], catches: [] },
        { name: 'Sam', facts: [], catches: [] },
      ],
      recentHeard: [{ speaker: 'Sam', text: 'Where is your head at on the regulars and the price?' }],
      line: guest.text,
    }, { stream, log: () => undefined });
    state.recordReading('josh-1', value);

    expect(value.answersOpenQuestion).toBe(true);
    expect(next(state.view(2), { kind: 'heard', line: guest, reading: value })).toMatchObject({
      kind: 'ConfirmDecision',
    });
  });

  it('commits when the guest agrees to the host\'s confirmation', () => {
    const state = make();
    heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Call Auntie Mary in, Bao covers the till from 8.' });
    record(state, 'josh-1', reading({
      kind: 'answer',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: { covered: true, evidence: 'Call Auntie Mary in' },
        practical: { covered: true, evidence: 'Bao covers the till from 8' },
      },
    }));
    state.setConfirmationAsked(true);
    const yes = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'Yes, that\'s right.' }, 2);
    record(state, 'josh-2', reading({ kind: 'agree', answersOpenQuestion: true }));

    expect(next(state.view(2), { kind: 'heard', line: yes })).toMatchObject({
      kind: 'CommitDecision', respondsTo: 'josh-2',
    });
  });

  it('explains an urgent deadline once, offers on a second park, then closes honestly on a third', () => {
    const state = make();
    const first = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us leave that for later.' });
    record(state, 'josh-1', reading({ kind: 'park' }));

    expect(next(state.view(1), { kind: 'heard', line: first })).toMatchObject({
      kind: 'Speak', speaker: 'Ada', purpose: 'clarify',
    });
    const owner = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'We must decide before doors open at 8.' }, 2);
    expect(next(state.view(2), { kind: 'heard', line: owner })).toMatchObject({ kind: 'Wait' });

    const second = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'Leave it for later.' }, 3);
    record(state, 'josh-2', reading({ kind: 'park' }));
    expect(next(state.view(3), { kind: 'heard', line: second })).toMatchObject({ kind: 'Offer' });
    state.noteOffer();

    const third = heard(state, { id: 'josh-3', speaker: 'Josh', text: 'Really, later.' }, 4);
    record(state, 'josh-3', reading({ kind: 'park' }));
    expect(next(state.view(4), { kind: 'heard', line: third })).toMatchObject({
      kind: 'Unresolved', respondsTo: 'josh-3',
    });
  });

  it('offers the guest\'s own idea first, then the two directions, then closes after the second offer', () => {
    const state = make({ directions: ['Ask Auntie Mary to come in.', 'An agency temp needs notice and a till login.'] });
    const idea = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Use the kiosk for orders.' });
    record(state, 'josh-1', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk for orders' },
        catchAddressed: off,
        practical: off,
      },
    }));
    state.noteFollowUp();
    state.noteFollowUp();

    const first = next(state.view(1), { kind: 'heard', line: idea });
    expect(first).toMatchObject({ kind: 'Offer', proposal: 'Use the kiosk for orders' });
    state.noteOffer();

    const vague = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'No, not that.' }, 2);
    record(state, 'josh-2', reading({ kind: 'answer' }));
    const second = next(state.view(2), { kind: 'heard', line: vague });
    expect(second).toMatchObject({ kind: 'Offer', choices: ['Ask Auntie Mary to come in', 'An agency temp needs notice and a till login'] });
    state.noteOffer();

    const again = heard(state, { id: 'josh-3', speaker: 'Josh', text: 'Hmm, still no.' }, 3);
    record(state, 'josh-3', reading({ kind: 'answer' }));
    expect(next(state.view(3), { kind: 'heard', line: again })).toMatchObject({
      kind: 'Unresolved', respondsTo: 'josh-3',
    });
  });

  it('asks one open what-would-you-rather-do when the two directions were already the first offer', () => {
    const state = make();
    state.noteFollowUp();
    state.noteFollowUp();
    state.noteOffer();

    const line = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Anything, really.' });
    record(state, 'josh-1', reading({ kind: 'answer' }));
    expect(next(state.view(1), { kind: 'heard', line })).toMatchObject({ kind: 'Offer', openAsk: true });
  });


  it('still answers a question and an addressed line after two offers', () => {
    const asked = make();
    asked.noteOffer();
    asked.noteOffer();
    const question = heard(asked, { id: 'josh-q', speaker: 'Josh', text: 'Can the till take a new login?' });
    record(asked, 'josh-q', reading({ kind: 'question', relevantFactIds: ['0:1'] }));
    expect(next(asked.view(1), { kind: 'heard', line: question })).toMatchObject({
      kind: 'Speak', speaker: 'Bao', purpose: 'answer',
    });

    const addressed = make();
    addressed.noteOffer();
    addressed.noteOffer();
    const line = heard(addressed, { id: 'josh-a', speaker: 'Josh', text: 'Ada, what do you think?' });
    record(addressed, 'josh-a', reading({ kind: 'answer', addressee: 'Ada' }));
    expect(next(addressed.view(1), { kind: 'heard', line })).toMatchObject({
      kind: 'Speak', speaker: 'Ada', purpose: 'answer',
    });
  });

  it('never makes more than two offers or two follow-ups on one topic', () => {
    const state = make();
    let offers = 0;
    let followUps = 0;
    let last: string | undefined;
    for (let index = 0; index < 10; index += 1) {
      const id = `loop-${index}`;
      const line = heard(state, { id, speaker: 'Josh', text: `Vague line ${index}.` }, index + 1);
      const value = record(state, id, reading({ kind: 'answer' }));
      const decision = next(state.view(index + 1), { kind: 'heard', line, reading: value });
      last = decision.kind;
      if (decision.kind === 'Offer') {
        offers += 1;
        state.noteOffer();
      }
      if (decision.kind === 'Speak' && decision.followUp === true) {
        followUps += 1;
        state.noteFollowUp();
      }
    }

    expect(offers).toBe(2);
    expect(followUps).toBe(2);
    expect(last).toBe('Unresolved');
  });

  it('gives every kind of guest line a reply in every main state, except a second noise in a row', () => {
    const kinds: GuestLineKind[] = ['idea', 'question', 'answer', 'agree', 'unsure', 'park', 'off_topic', 'noise'];
    const gates: Array<{ name: string; prepare: (state: MeetingState) => void }> = [
      { name: 'fresh topic', prepare: () => undefined },
      {
        name: 'after catch',
        prepare: (state) => {
          heard(state, { id: 'prep-idea', speaker: 'Josh', text: 'Call Auntie Mary in.' });
          record(state, 'prep-idea', reading({
            kind: 'idea',
            readiness: { action: { covered: true, evidence: 'Call Auntie Mary in' }, catchAddressed: off, practical: off },
          }));
          heard(state, { id: 'prep-catch', speaker: 'Bao', text: 'A new till login takes fifteen minutes.', catchId: '0:catch:1' }, 2);
        },
      },
      { name: 'after offer 1', prepare: (state) => { state.noteOffer(); state.setOfferAsked(true); } },
      { name: 'after offer 2', prepare: (state) => { state.noteOffer(); state.noteOffer(); state.setOfferAsked(true); } },
      { name: 'after confirmation', prepare: (state) => state.setConfirmationAsked(true) },
    ];

    for (const gate of gates) {
      for (const kind of kinds) {
        const state = make();
        gate.prepare(state);
        const at = state.view(0).lines.length + 1;
        const id = `${gate.name}-${kind}`;
        const line = heard(state, { id, speaker: 'Josh', text: `Guest ${kind}.`, proposal: kind === 'idea' }, at);
        const value = record(state, id, reading({
          kind,
          answersOpenQuestion: true,
          ...(kind === 'question' ? { relevantFactIds: ['0:1'] } : {}),
        }));
        const decision = next(state.view(at), { kind: 'heard', line, reading: value });
        expect(decision.kind, `${gate.name}: ${kind}`).not.toBe('Wait');
      }
    }
  });

  it('is ready once the catch is raised and the guest has replied, even when they did not solve it', () => {
    const state = make();
    heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Call Auntie Mary in.' });
    record(state, 'josh-1', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: off,
        practical: off,
      },
    }));
    expect(readinessMet(state.view(1))).toBe(false);

    const catchLine = heard(state, { id: 'ada-1', speaker: 'Ada', text: 'Calling Auntie Mary in means double pay.', catchId: '0:catch:0' }, 2);
    expect(next(state.view(2), { kind: 'heard', line: catchLine })).toMatchObject({ kind: 'Wait' });
    expect(readinessMet(state.view(2))).toBe(false);

    const reply = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'That is fine, we still do it.' }, 3);
    record(state, 'josh-2', reading({
      kind: 'answer',
      readiness: {
        action: { covered: true, evidence: 'Call Auntie Mary in' },
        catchAddressed: off,
        practical: off,
      },
    }));

    expect(readinessMet(state.view(3))).toBe(true);
    expect(next(state.view(3), { kind: 'heard', line: reply })).toMatchObject({ kind: 'ConfirmDecision' });
  });

  it('treats a topic with no catch as ready once the action is covered', () => {
    const state = make({ catches: [] });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Use the kiosk for orders.' });
    record(state, 'josh-1', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk for orders' },
        catchAddressed: off,
        practical: off,
      },
    }));

    expect(readinessMet(state.view(1))).toBe(true);
    expect(next(state.view(1), { kind: 'heard', line: guest })).toMatchObject({ kind: 'ConfirmDecision' });
  });

  it('offers the guest\'s own idea after two follow-ups instead of asking a third time', () => {
    const state = make();
    const first = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'We should do something.' });
    record(state, 'josh-1', reading({ kind: 'answer' }));
    expect(next(state.view(1), { kind: 'heard', line: first })).toMatchObject({
      kind: 'Speak', purpose: 'clarify', followUp: true,
    });
    state.noteFollowUp();

    const second = heard(state, { id: 'josh-2', speaker: 'Josh', text: 'You know, the usual.' }, 2);
    record(state, 'josh-2', reading({ kind: 'answer' }));
    expect(next(state.view(2), { kind: 'heard', line: second })).toMatchObject({
      kind: 'Speak', purpose: 'clarify', followUp: true,
    });
    state.noteFollowUp();

    const third = heard(state, { id: 'josh-3', speaker: 'Josh', text: 'Use the kiosk.' }, 3);
    record(state, 'josh-3', reading({
      kind: 'idea',
      readiness: {
        action: { covered: true, evidence: 'Use the kiosk' },
        catchAddressed: off,
        practical: off,
      },
    }));
    expect(next(state.view(3), { kind: 'heard', line: third })).toMatchObject({
      kind: 'Offer', proposal: 'Use the kiosk',
    });
  });

  it('defers a topic that can wait to its later slot', () => {
    const state = make({ canWait: true, deadline: 'after the lunch rush' });
    const guest = heard(state, { id: 'josh-1', speaker: 'Josh', text: 'Let us leave that for later.' });
    record(state, 'josh-1', reading({ kind: 'park' }));

    const decision = next(state.view(1), { kind: 'heard', line: guest });
    expect(decision).toMatchObject({ kind: 'Speak', speaker: 'Sam', purpose: 'defer' });
    expect(decision.reason).toContain('after the lunch rush');
  });

  it('names the facts the opening speaker tells, grouping consecutive facts by the same knower', () => {
    const state = make();
    const handover = heard(state, { id: 'sam-1', speaker: 'Sam', text: 'Ada, what happened?' });
    const first = next(state.view(1), { kind: 'heard', line: handover });
    expect(first).toMatchObject({ kind: 'Speak', speaker: 'Ada', purpose: 'brief', factIds: ['0:0'] });
  });
});
