import { describe, expect, it, vi } from 'vitest';
import type { Scenario } from '@kaki/shared';
import { AiVisitor, judgePrompt, parseJudgement, PERSONAS, visitorPrompt, type Persona } from './ai-visitor';
import { behaviourForPersona } from './playtest-behaviours';
import type { AnswerContext, FinishContext, Line } from './live-playtest';

const scenario: Scenario = {
  id: 'kopitiam', organisation: 'Nanyang Kopi & Toast', meetingTitle: 'Opening',
  roles: [
    { id: 'producer', label: 'Operations Director', card: { youAre: 'You are Wei Ling.', facts: [], responsibility: 'Lead opening day.' } },
    { id: 'marketing_lead', label: 'Marketing Lead' },
  ],
  attendees: [
    { name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' },
    { name: 'Daniel', role: 'marketing_lead', zoomDisplayName: 'Daniel' },
  ],
  agenda: [
    { title: 'Counter staffing', minutes: 5, ownerRole: 'producer', briefing: 'One person called in sick.', decision: 'Who covers?', seatFacts: { producer: 'Rest day means double pay.' } },
    { title: 'Kopi prices', minutes: 5, ownerRole: 'producer', briefing: 'Prices changed.' },
    { title: 'Food safety complaint', minutes: 5, ownerRole: 'producer', sensitive: true, briefing: 'A customer was sick.', sayExactly: ['$85'] },
  ],
  npcs: [
    { attendee: 'Wei Ling', voice: 'voice', personality: 'Direct.', agenda: 'Keep the opening sound.', concerns: ['Making a promise the shop cannot keep.'], knows: ['The fridge log shows a three-hour gap.'] },
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
  unsupported: [{ line: 'Who covers the counter?', fact: 'Nobody named a cover plan.', reason: 'Not in the canon.' }],
  toneBreaches: [{ line: 'Who covers the counter?', reason: 'Makes light of a sensitive topic.' }],
});
const usage = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };

describe('AI visitor prompts and judge', () => {
  it.each(['hesitant', 'terse', 'off-topic', 'inventive', 'delegator'] as Persona[])('builds a %s prompt with seat, topic and both sides of the transcript', (persona) => {
    const prompt = visitorPrompt(persona, answer);
    expect(prompt[0]!.content).toContain('Operations Director');
    expect(prompt[0]!.content).toContain('opening-day lead');
    expect(prompt[0]!.content).toContain('Persona:');
    expect(prompt[1]!.content).toContain('Counter staffing');
    expect(prompt[1]!.content).toContain('Rest day means double pay.');
    expect(prompt[1]!.content).toContain('Sam: Who covers the counter?');
    expect(prompt[1]!.content).toContain('Robot Visitor: Ask Mary, with double pay.');
  });

  it('keeps the five wording personas and adds four behaviour personas', () => {
    expect(PERSONAS).toEqual(['hesitant', 'terse', 'off-topic', 'inventive', 'delegator', 'silent', 'interrupter', 'flip-flop', 'rejoin']);
    expect(behaviourForPersona('silent')).toBe('silent');
    expect(behaviourForPersona('interrupter')).toBe('interrupter');
    expect(behaviourForPersona('flip-flop')).toBe('flip-flop');
    expect(behaviourForPersona('rejoin')).toBe('rejoin');
    for (const persona of ['hesitant', 'terse', 'off-topic', 'inventive', 'delegator'] as const) {
      expect(behaviourForPersona(persona)).toBeUndefined();
    }
  });

  it('exposes the persona behaviour on the hooks object', () => {
    const completeWithUsage = vi.fn();
    expect(new AiVisitor('silent', { completeWithUsage }).behaviour).toBe('silent');
    expect(new AiVisitor('rejoin', { completeWithUsage }).behaviour).toBe('rejoin');
    expect(new AiVisitor('terse', { completeWithUsage }).behaviour).toBeUndefined();
  });

  it('adds the flip-flop reversal phrase to the second call', async () => {
    const completeWithUsage = vi.fn().mockResolvedValue({ content: 'Use an agency temp.', usage });
    const visitor = new AiVisitor('flip-flop', { completeWithUsage });
    await expect(visitor.answer({ ...answer, intent: 'Actually, scrap that — reverse your last call.' }))
      .resolves.toBe('Actually, scrap that — Use an agency temp.');
    await expect(visitor.answer({ ...answer, intent: 'make a call' })).resolves.toBe('Use an agency temp.');
  });

  it('sends only played agenda canon and the full transcript to the judge', () => {
    const prompt = judgePrompt(finish)[1]!.content;
    expect(prompt).toContain('One person called in sick.');
    expect(prompt).not.toContain('Prices changed.');
    expect(prompt).toContain('Sam: Who covers the counter?');
    expect(prompt).toContain('Robot Visitor: Ask Mary, with double pay.');
  });

  it('gives the judge the full cast, character facts and sensitive flags', () => {
    const prompt = judgePrompt({ scenario, transcript, playedTopics: [2] })[1]!.content;
    expect(prompt).toContain('"cast"');
    expect(prompt).toContain('Wei Ling');
    expect(prompt).toContain('Operations Director');
    expect(prompt).toContain('Daniel');
    expect(prompt).toContain('Marketing Lead');
    expect(prompt).toContain('The fridge log shows a three-hour gap.');
    expect(prompt).toContain('Making a promise the shop cannot keep.');
    expect(prompt).toContain('"sensitive":true');
    expect(prompt).toContain('$85');
  });

  it('parses scores, contradictions, unsupported facts and tone breaches, and rejects malformed replies loudly', () => {
    const judgement = parseJudgement(validJudgement, transcript);
    expect(judgement.realistic.score).toBe(5);
    expect(judgement.unsupported).toEqual([{ line: 'Who covers the counter?', fact: 'Nobody named a cover plan.', reason: 'Not in the canon.' }]);
    expect(judgement.toneBreaches).toEqual([{ line: 'Who covers the counter?', reason: 'Makes light of a sensitive topic.' }]);
    expect(() => parseJudgement('{oops', transcript)).toThrow(/malformed JSON/);
    expect(() => parseJudgement('{}', transcript)).toThrow(/missing contradictions|missing natural/);
    expect(() => parseJudgement(validJudgement.replace('Ask Mary, with double pay.', 'A line nobody said.'), transcript)).toThrow(/quote an actual transcript/);
  });

  it('rejects findings whose quote is not in the transcript and replies missing the new lists', () => {
    const strayUnsupported = JSON.parse(validJudgement);
    strayUnsupported.unsupported[0].line = 'A line nobody said.';
    expect(() => parseJudgement(JSON.stringify(strayUnsupported), transcript)).toThrow(/quote an actual transcript/);

    const strayTone = JSON.parse(validJudgement);
    strayTone.toneBreaches[0].line = 'A line nobody said.';
    expect(() => parseJudgement(JSON.stringify(strayTone), transcript)).toThrow(/quote an actual transcript/);

    const missingUnsupported = JSON.parse(validJudgement);
    delete missingUnsupported.unsupported;
    expect(() => parseJudgement(JSON.stringify(missingUnsupported), transcript)).toThrow(/missing unsupported list/);

    const missingTone = JSON.parse(validJudgement);
    delete missingTone.toneBreaches;
    expect(() => parseJudgement(JSON.stringify(missingTone), transcript)).toThrow(/missing toneBreaches list/);
  });

  it('caps visitor attempts at 40, judge calls at one, and totals API token usage', async () => {
    const completeWithUsage = vi.fn().mockResolvedValue({ content: 'Okay, ask Mary.', usage });
    const visitor = new AiVisitor('terse', { completeWithUsage });
    for (let i = 0; i < 40; i += 1) expect(await visitor.answer(answer)).toBe('Okay, ask Mary.');
    await expect(visitor.answer(answer)).rejects.toThrow(/40-call cap/);
    expect(completeWithUsage).toHaveBeenCalledTimes(40);
    expect(completeWithUsage.mock.calls[0]![1]).toMatchObject({ maxTokens: 96, reasoningEffort: 'none' });
    completeWithUsage.mockResolvedValueOnce({ content: validJudgement, usage });
    const summary = (await visitor.finish(finish)).summaryLines;
    expect(summary).toHaveLength(7);
    expect(summary).toContain('unsupported: 1');
    expect(summary).toContain('tone breaches: 1');
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
