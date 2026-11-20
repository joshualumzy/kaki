import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { LlmError, type ChatMessage, type CompleteOptions } from '../server/src/llm';
import type { Line } from './live-playtest';
import {
  cannedRobotDecision, decideRobotCall, parseRobotDecision, robotDecisionPrompt, type RobotDecisionRequest,
} from './robot-decision';

const scenario: Scenario = {
  id: 'kopitiam', organisation: 'Nanyang Kopi & Toast', meetingTitle: 'Opening',
  roles: [
    { id: 'producer', label: 'Operations Director', card: { youAre: 'You are Wei Ling.', facts: [], responsibility: 'Lead opening day.' } },
  ],
  attendees: [{ name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' }],
  agenda: [
    {
      title: 'Delivery app', minutes: 5, canWait: false, deadline: 'before the lunch rush', ownerRole: 'producer',
      briefing: [{ text: 'The office orders are the only profitable line.', knownBy: [{ attendee: 'Wei Ling', why: 'you saw the numbers' }] }],
      decision: 'How do we sell the platter?',
      seatFacts: { producer: 'Only 30 trays came in this morning.' },
    },
  ],
};

const transcript: Line[] = [
  { at: 'a', sourceTime: 'a', agendaIndex: 0, speaker: 'Sam', text: 'Delivery app is next.' },
  { at: 'b', sourceTime: 'b', agendaIndex: 0, speaker: 'Mei', text: "We've only got 30 trays." },
];

function request(overrides: Partial<RobotDecisionRequest> = {}): RobotDecisionRequest {
  return { scenario, role: 'producer', topicTitle: 'Delivery app', transcript, ...overrides };
}

function fakeModel(reply: string | Error) {
  return {
    complete: vi.fn(async (_messages: ChatMessage[], _options?: CompleteOptions) => {
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
}

describe('scripted guest call prompt', () => {
  it('gives the model the seat card, topic facts and what was heard', () => {
    const prompt = robotDecisionPrompt(request()).map((message) => message.content).join('\n');
    expect(prompt).toContain('You are Wei Ling, Operations Director');
    expect(prompt).toContain('Lead opening day.');
    expect(prompt).toContain('Briefing: The office orders are the only profitable line.');
    expect(prompt).toContain('Decision at hand: How do we sell the platter?');
    expect(prompt).toContain("Your seat's known fact: Only 30 trays came in this morning.");
    expect(prompt).toContain('[topic 1] Mei: We\'ve only got 30 trays.');
  });
});

describe('scripted guest call parsing', () => {
  it('returns one short spoken line', () => {
    expect(parseRobotDecision(JSON.stringify({ call: 'Push the platter while the trays last.' })))
      .toBe('Push the platter while the trays last.');
  });

  it('rejects malformed or unusable replies so the caller can fall back loudly', () => {
    expect(() => parseRobotDecision('{oops')).toThrow(/not valid JSON/);
    expect(() => parseRobotDecision(JSON.stringify({ call: 42 }))).toThrow(/no usable call/);
    expect(() => parseRobotDecision(JSON.stringify({ call: '' }))).toThrow(/one short line/);
    expect(() => parseRobotDecision(JSON.stringify({ call: 'one\ntwo' }))).toThrow(/one short line/);
  });
});

describe('scripted guest call', () => {
  it('uses one model call for the call', async () => {
    const model = fakeModel(JSON.stringify({ call: 'Push the platter while the trays last.' }));
    await expect(decideRobotCall(request(), model)).resolves.toEqual({ call: 'Push the platter while the trays last.' });
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(model.complete.mock.calls[0]![1]).toMatchObject({ json: true });
  });

  it('falls back to the logged canned call with a warning when the model fails', async () => {
    const outcome = await decideRobotCall(request(), fakeModel(new LlmError('HTTP 500: secret detail')));
    expect(outcome.call).toBe(cannedRobotDecision('Delivery app'));
    expect(outcome.warning).toContain('Delivery app');
    expect(outcome.warning).toContain('model request failed');
    expect(outcome.warning).not.toContain('secret detail');
  });

  it('fails loudly when a failed call has no canned line either', async () => {
    await expect(decideRobotCall(request({ topicTitle: 'Unknown topic' }), fakeModel('{oops')))
      .rejects.toThrow(/No canned call prepared for: Unknown topic/);
  });
});
