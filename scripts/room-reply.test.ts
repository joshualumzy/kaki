import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { LlmError, type ChatMessage, type CompleteOptions } from '../server/src/services/llm';
import type { Line } from './live-playtest';
import {
  cannedRoomReply, decideRoomReply, parseRoomReply, roomReplyPrompt, type RoomReplyRequest,
} from './room-reply';

const scenario: Scenario = {
  id: 'kopitiam', organisation: 'Nanyang Kopi & Toast', meetingTitle: 'Opening',
  roles: [
    { id: 'operations_director', label: 'Operations Director', card: { youAre: 'You are Wei Ling.', facts: [], responsibility: 'Lead opening day.' } },
  ],
  attendees: [{ name: 'Wei Ling', role: 'operations_director', displayName: 'Wei Ling' }],
  agenda: [
    {
      title: 'Delivery app', minutes: 5, canWait: false, deadline: 'before the lunch rush', ownerRole: 'operations_director',
      briefing: [{ text: 'The office orders are the only profitable line.', knownBy: [{ attendee: 'Wei Ling', why: 'you saw the numbers' }] }],
      decision: 'How do we sell the platter?',
      seatFacts: { operations_director: 'Only 30 trays came in this morning.' },
    },
    {
      title: 'Counter staffing', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'operations_director',
      briefing: [{ text: 'One person called in sick.', knownBy: [{ attendee: 'Wei Ling', why: 'you got the text' }] }],
    },
  ],
};

const transcript: Line[] = [
  { at: 'a', sourceTime: 'a', agendaIndex: 0, speaker: 'Sam', text: 'Delivery app is next.' },
  { at: 'b', sourceTime: 'b', agendaIndex: 0, speaker: 'Mei', text: "We've only got 30 trays." },
  { at: 'c', sourceTime: 'c', agendaIndex: 0, speaker: 'Robot Visitor', text: "Let's push the fifty-dollar platter." },
  { at: 'd', sourceTime: 'd', agendaIndex: 0, speaker: 'Sam', text: "What's your gut telling you about the office orders once the 30 trays run out?" },
];
const fresh = transcript.slice(2);

function request(overrides: Partial<RoomReplyRequest> = {}): RoomReplyRequest {
  return {
    scenario,
    role: 'operations_director',
    topicTitle: 'Delivery app',
    transcript,
    decision: "Let's push the fifty-dollar platter.",
    fresh,
    hostName: 'Sam',
    robotLineCount: 1,
    ...overrides,
  };
}

function fakeModel(reply: string | Error) {
  return {
    complete: vi.fn(async (_messages: ChatMessage[], _options?: CompleteOptions) => {
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

describe('scripted room reply prompt', () => {
  it('gives the model the seat card, the topic facts, the fixed call and the fresh lines', () => {
    const prompt = roomReplyPrompt(request()).map((message) => message.content).join('\n');
    expect(prompt).toContain('You are Wei Ling, Operations Director');
    expect(prompt).toContain('Lead opening day.');
    expect(prompt).toContain('Briefing: The office orders are the only profitable line.');
    expect(prompt).toContain('Decision at hand: How do we sell the platter?');
    expect(prompt).toContain("Your seat's known fact: Only 30 trays came in this morning.");
    expect(prompt).toContain('Your fixed call on this topic, already made in the meeting: "Let\'s push the fifty-dollar platter."');
    expect(prompt).toContain("The newest room lines since your last line, oldest first:\nRobot Visitor: Let's push the fifty-dollar platter.\nSam: What's your gut telling you");
    expect(prompt).toContain('[topic 1] Mei: We\'ve only got 30 trays.');
  });

  it('says on the tabling topic that the robot has asked to table and has no call', () => {
    const tabling = request({
      topicTitle: 'Counter staffing',
      decision: undefined,
      transcript: [
        { at: 'a', sourceTime: 'a', agendaIndex: 1, speaker: 'Robot Visitor', text: "Let's table it for now and set up a follow-up." },
        { at: 'b', sourceTime: 'b', agendaIndex: 1, speaker: 'Sam', text: 'How about we ring Auntie Mary and offer her double pay?' },
      ],
      fresh: [],
      robotLineCount: 1,
    });
    tabling.fresh = tabling.transcript.slice(1);
    const prompt = roomReplyPrompt(tabling).map((message) => message.content).join('\n');
    expect(prompt).toContain('On this topic you asked the room to table it, and you have no call of your own yet.');
    expect(prompt).not.toContain('Your fixed call on this topic');
    expect(prompt).toContain('Sam: How about we ring Auntie Mary and offer her double pay?');
  });
});

describe('scripted room reply parsing', () => {
  it('returns the reply and why the robot spoke', () => {
    expect(parseRoomReply(JSON.stringify({ reply: 'I would push the platter while the trays last.', kind: 'answer' })))
      .toEqual({ reply: 'I would push the platter while the trays last.', kind: 'answer' });
  });

  it('returns a null reply when the line is not for the guest', () => {
    expect(parseRoomReply(JSON.stringify({ reply: null, kind: 'none' }))).toEqual({ reply: null, kind: 'none' });
  });

  it('rejects malformed or unusable JSON so the caller can fall back loudly', () => {
    expect(() => parseRoomReply('{oops')).toThrow(/not valid JSON/);
    expect(() => parseRoomReply(JSON.stringify({ reply: 'Yes.', kind: 'maybe' }))).toThrow(/no usable kind/);
    expect(() => parseRoomReply(JSON.stringify({ reply: 42, kind: 'answer' }))).toThrow(/no usable line/);
  });

  it('uses one model call for the whole batch of fresh lines', async () => {
    const model = fakeModel(JSON.stringify({ reply: 'We still sell the platter.', kind: 'answer' }));
    const outcome = await decideRoomReply(request(), model);
    expect(outcome).toEqual({ reply: 'We still sell the platter.', kind: 'answer' });
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(model.complete.mock.calls[0]![1]).toMatchObject({ json: true });
  });

  it('falls back to the logged canned line with a WARN when the model returns bad JSON', async () => {
    const outcome = await decideRoomReply(request(), fakeModel('{oops'));
    expect(outcome).toMatchObject({ reply: "Yes, that's my call.", kind: 'confirm' });
    expect(outcome.warning).toContain("What's your gut telling you about the office orders once the 30 trays run out?");
    expect(outcome.warning).toContain('the model reply was not valid JSON');
  });

  it('falls back with a request error kind, never the raw error, when the model call fails', async () => {
    const outcome = await decideRoomReply(request(), fakeModel(new LlmError('HTTP 500: secret detail')));
    expect(outcome).toMatchObject({ reply: "Yes, that's my call.", kind: 'confirm' });
    expect(outcome.warning).toContain('model request failed');
    expect(outcome.warning).not.toContain('secret detail');
  });

  it('keeps the old offer wording in the canned backstop on the tabling topic', () => {
    const tabling = request({
      topicTitle: 'Counter staffing',
      decision: undefined,
      transcript: [
        { at: 'a', sourceTime: 'a', agendaIndex: 1, speaker: 'Robot Visitor', text: "Let's table it for now and set up a follow-up." },
        { at: 'b', sourceTime: 'b', agendaIndex: 1, speaker: 'Sam', text: 'How about we ring Auntie Mary and offer her double pay?' },
      ],
    });
    tabling.fresh = tabling.transcript.slice(1);
    expect(cannedRoomReply(tabling)).toEqual({ reply: "Yes, let's go with that.", kind: 'accept-offer' });
  });
});
