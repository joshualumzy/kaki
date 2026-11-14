import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { AiVisitor, judgePrompt, parseJudgement, visitorPrompt, type Persona } from './ai-visitor';
import type { AnswerContext, FinishContext, Line } from './live-playtest';

const scenario: Scenario = {
  id: 'kopitiam', organisation: 'Nanyang Kopi & Toast', meetingTitle: 'Opening',
  roles: [{ id: 'producer', label: 'Operations Director', card: { youAre: 'You are Wei Ling.', facts: [], responsibility: 'Lead opening day.' } }],
  attendees: [{ name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' }],
  agenda: [
    { title: 'Counter staffing', minutes: 5, ownerRole: 'producer', briefing: 'One person called in sick.', decision: 'Who covers?', seatFacts: { producer: 'Rest day means double pay.' } },
    { title: 'Kopi prices', minutes: 5, ownerRole: 'producer', briefing: 'Prices changed.' },
  ],
};
const transcript: Line[] = [
  { at: 'a', sourceTime: 'a', agendaIndex: 0, speaker: 'Sam', text: 'Who covers the counter?' },
  { at: 'b', sourceTime: 'b', agendaIndex: 0, speaker: 'Robot Visitor', text: 'Ask Mary, with double pay.' },
];
const answer: AnswerContext = { scenario, role: 'producer', topicTitle: 'Counter staffing', transcript, intent: 'Make a call.' };
const finish: FinishContext = { scenario, transcript, playedTopics: [0] };
const validJudgement = JSON.stringify({
  natural: { score: 4, reason: 'Sounds conversational.' }, dynamic: { score: 3, reason: 'Sam asks a question.' },
  fun: { score: 2, reason: 'A little dry.' }, realistic: { score: 5, reason: 'Double pay is grounded.' },
  contradictions: [{ line: 'Ask Mary, with double pay.', reason: 'Example finding.' }],
});
const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };

describe('AI visitor prompts and judge', () => {
  it.each(['hesitant', 'terse', 'off-topic', 'inventive'] as Persona[])('builds a %s prompt with seat, topic and both sides of the transcript', (persona) => {
    const prompt = visitorPrompt(persona, answer);
    expect(prompt[0]!.content).toContain('Operations Director');
    expect(prompt[0]!.content).toContain('opening-day lead');
    expect(prompt[0]!.content).toContain('Persona:');
    expect(prompt[1]!.content).toContain('Counter staffing');
    expect(prompt[1]!.content).toContain('Rest day means double pay.');
    expect(prompt[1]!.content).toContain('Sam: Who covers the counter?');
    expect(prompt[1]!.content).toContain('Robot Visitor: Ask Mary, with double pay.');
  });

  it('sends only played agenda canon and the full transcript to the judge', () => {
    const prompt = judgePrompt(finish)[1]!.content;
    expect(prompt).toContain('One person called in sick.');
    expect(prompt).not.toContain('Prices changed.');
    expect(prompt).toContain('Sam: Who covers the counter?');
    expect(prompt).toContain('Robot Visitor: Ask Mary, with double pay.');
  });

  it('parses scores and exact transcript contradictions, and rejects malformed replies loudly', () => {
    expect(parseJudgement(validJudgement, transcript).realistic.score).toBe(5);
    expect(() => parseJudgement('{oops', transcript)).toThrow(/malformed JSON/);
    expect(() => parseJudgement('{}', transcript)).toThrow(/missing contradictions|missing natural/);
    expect(() => parseJudgement(validJudgement.replace('Ask Mary, with double pay.', 'A line nobody said.'), transcript)).toThrow(/quote an actual transcript/);
  });

  it('caps visitor attempts at 40, judge calls at one, and totals API token usage', async () => {
    const completeWithUsage = vi.fn().mockResolvedValue({ content: 'Okay, ask Mary.', usage });
    const visitor = new AiVisitor('terse', { completeWithUsage });
    for (let i = 0; i < 40; i += 1) expect(await visitor.answer(answer)).toBe('Okay, ask Mary.');
    await expect(visitor.answer(answer)).rejects.toThrow(/40-call cap/);
    expect(completeWithUsage).toHaveBeenCalledTimes(40);
    expect(completeWithUsage.mock.calls[0]![1]).toMatchObject({ maxTokens: 96, reasoningEffort: 'none' });
    completeWithUsage.mockResolvedValueOnce({ content: validJudgement, usage });
    expect((await visitor.finish(finish)).summaryLines).toHaveLength(5);
    await expect(visitor.finish(finish)).rejects.toThrow(/1 per persona/);
    expect(completeWithUsage).toHaveBeenCalledTimes(41);
    expect(visitor.totalTokens).toBe(41 * 14);
  });

  it('retries a visitor failure once within the cap and then fails loudly', async () => {
    const completeWithUsage = vi.fn().mockRejectedValue(new Error('gateway down'));
    const visitor = new AiVisitor('hesitant', { completeWithUsage });
    await expect(visitor.answer(answer)).rejects.toThrow(/two attempts.*gateway down/);
    expect(visitor.visitorCalls).toBe(2);
  });
});
