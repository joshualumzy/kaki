import { describe, expect, it } from 'vitest';
import {
  evidenceForTopic, judgePrompt, minutesExcerpt, parseAnswerKey, parseJudgeReply, parseReport,
  prepareTopic, renderTotals, renderVerdict, scoreTopic, summarizeVerdicts, type AnswerKey, type KeyTopic,
} from './eval-key';

const topic: KeyTopic = {
  title: 'Counter staffing',
  shouldNote: [
    'A decision on who covers the counter.',
    'A to-do for the person who arranges the cover.',
  ],
  shouldWingman: [
    { moment: 'A colleague asks the guest by name to take on a follow-up.', kind: 'asked_you' },
    { moment: 'The guest is handed a to-do for the counter cover.', kind: 'given' },
    { moment: 'A workspace record about rest-day pay becomes relevant.', kind: 'record' },
  ],
  shouldOfferTool: [
    'A to-do to email the staff member about cover.',
    'A to-do to post the cover plan in the team chat.',
  ],
  shouldStaySilent: [
    'Small talk about the morning that does not change the cover plan.',
    'A promise to think about the rota later with no concrete deliverable.',
  ],
};
const key: AnswerKey = { scenario: 'kopitiam', topics: [topic] };

const reportMarkdown = [
  '# Kopitiam live playtest',
  '',
  '## Full API transcript',
  '',
  '- 2026-01-01T00:00:00.000Z (source t1, item 1) [Counter staffing] **Sam:** Who covers the counter?',
  '- 2026-01-01T00:00:01.000Z (source t2, item 1) [Counter staffing] **Robot Visitor:** Ask Mary, with double pay.',
  '',
  '## Task cards seen (latest API state)',
  '',
  '- task-1 · Counter staffing · email · SUGGESTED · Ask Mary to cover · owner Operations Director',
  '',
  '## Wingman notes seen',
  '',
  '- 2026-01-01T00:00:02.000Z · item 1 · Counter staffing · given/quiet · You were given a to-do — Ask Mary to cover',
  '- 2026-01-01T00:00:03.000Z · item 1 · Counter staffing · answer/quiet · Your answer — Nothing on that in your records',
  '- 2026-01-01T00:00:04.000Z · item 1 · Counter staffing · record/quiet · Rest-day pay — Double pay applies',
  '',
  '## Notetaker output',
  '',
  '### Decisions',
  '',
  '- [item 1 · Counter staffing] Ask Mary, with double pay.',
  '',
  '### To-dos',
  '',
  '- [item 1 · Counter staffing] Ask Mary to cover · owner Wei Ling (Operations Director) · action email · fit ready (email) · status SUGGESTED',
  '- [item 1 · Counter staffing] Thank the team · owner Sam (General Manager) · action none · fit none · status SUGGESTED',
  '',
  '### Minutes',
  '',
  '- present: Publish meeting minutes to the team wiki (DRAFT_READY)',
  '```markdown',
  '# Meeting Minutes',
  '',
  '## Agenda Covered',
  '',
  '1. **Counter staffing** — how do we cover the counter?',
  '',
  '## Action Items & Follow-Ups',
  '',
  '- **Ask Mary to cover**',
  '',
  '## Discussion Transcript',
  '',
  '- **Sam:** Who covers the counter?',
  '```',
  '',
  '## Errors',
  '',
  '(none)',
].join('\n');

const validReply = JSON.stringify({
  shouldNote: [
    { gold: 1, applicable: true, found: 'D1', reason: 'The accepted call is recorded as a decision.' },
    { gold: 2, applicable: true, found: 'T1', reason: 'The cover to-do is recorded with an owner.' },
  ],
  shouldWingman: [
    { gold: 1, applicable: true, found: null, reason: 'Nobody asked the guest directly by name.' },
    { gold: 2, applicable: true, found: 'W1', reason: 'The guest was given the cover to-do.' },
    { gold: 3, applicable: true, found: 'W3', reason: 'Rest-day pay is relevant to the cover call.' },
  ],
  shouldOfferTool: [
    { gold: 1, applicable: true, found: 'O1', reason: 'The cover to-do fits an email.' },
    { gold: 2, applicable: true, found: null, reason: 'No chat post was offered.' },
  ],
  shouldStaySilent: [
    { found: 'T2', reason: 'Thanking the team is small talk with no concrete deliverable.' },
  ],
});

describe('answer-key validation', () => {
  it('accepts the key shape used by the judge', () => {
    expect(parseAnswerKey(key)).toEqual(key);
  });

  it('rejects a malformed key loudly', () => {
    expect(() => parseAnswerKey({ ...key, topics: [{ ...topic, shouldWingman: [{ moment: 'x', kind: 'nudge' }] }] }))
      .toThrow(/shouldWingman\[0\]\.kind/);
    expect(() => parseAnswerKey({ ...key, topics: [{ ...topic, shouldStaySilent: undefined }] }))
      .toThrow(/shouldStaySilent must be a list/);
    expect(() => parseAnswerKey({ ...key, topics: [topic, topic] })).toThrow(/repeats topic/);
  });
});

describe('playtest report parsing', () => {
  it('reads the transcript, private notes, notetaker output, minutes and cards by topic', () => {
    const report = parseReport(reportMarkdown);
    expect(report.transcript).toHaveLength(2);
    expect(report.transcript[0]).toMatchObject({ item: 1, topic: 'Counter staffing', speaker: 'Sam' });
    expect(report.wingmanNotes.map((note) => note.kind)).toEqual(['given', 'answer', 'record']);
    expect(report.decisions).toEqual([{ item: 1, topic: 'Counter staffing', text: 'Ask Mary, with double pay.' }]);
    expect(report.todos).toHaveLength(2);
    expect(report.todos[0]).toMatchObject({ title: 'Ask Mary to cover', action: 'email', fitStatus: 'ready', fitKind: 'email', status: 'SUGGESTED' });
    expect(report.minutes?.present).toBe(true);
    expect(report.minutes?.body).toContain('## Action Items & Follow-Ups');
    expect(report.taskCards).toHaveLength(1);
    expect(report.taskCards[0]).toMatchObject({ id: 'task-1', topic: 'Counter staffing', action: 'email', owner: 'Operations Director' });
  });

  it('keeps fenced minutes headings from ending the notetaker section', () => {
    const report = parseReport(reportMarkdown);
    expect(minutesExcerpt(report.minutes!)).toContain('## Action Items & Follow-Ups');
    expect(minutesExcerpt(report.minutes!)).not.toContain('## Discussion Transcript');
    expect(minutesExcerpt(report.minutes!)).not.toContain('## Agenda Covered');
  });
});

describe('judge prompt preparation', () => {
  const report = parseReport(reportMarkdown);
  const evidence = evidenceForTopic(report, 'Counter staffing');

  it('scores proactive notes but not answers to the guest, and sends every found id', () => {
    const prepared = prepareTopic(topic, evidence, false);
    expect(prepared.wingman.map((item) => item.id)).toEqual(['W1', 'W3']);
    expect(prepared.ignoredWingman.map((item) => item.id)).toEqual(['W2']);
    expect(prepared.offers.map((item) => item.id)).toEqual(['O1']);
    const prompt = judgePrompt(prepared, false).map((message) => message.content).join('\n');
    expect(prompt).toContain('W1.');
    expect(prompt).toContain('W3.');
    expect(prompt).not.toContain('W2. kind=answer');
    expect(prompt).toContain('D1.');
    expect(prompt).toContain('T1.');
    expect(prompt).toContain('O1.');
    expect(prompt).toContain('A colleague asks the guest by name to take on a follow-up. [asked_you]');
    expect(prompt).toContain('Sam: Who covers the counter?');
    expect(prompt).toContain('## Action Items & Follow-Ups');
    expect(prompt).not.toContain('**Sam:** Who covers the counter?');
  });

  it('in an empty workspace keeps only asked-you and given notes, and treats records and tool offers as breaches', () => {
    const prepared = prepareTopic(topic, evidence, true);
    expect(prepared.wingmanGold.map((moment) => moment.kind)).toEqual(['asked_you', 'given']);
    expect(prepared.toolGold).toEqual([]);
    expect(prepared.wingman.map((item) => item.id)).toEqual(['W1']);
    expect(prepared.wingmanBreaches.map((item) => item.id)).toEqual(['W2', 'W3']);
    expect(prepared.offerBreaches.map((item) => item.id)).toEqual(['O1']);
    expect(prepared.offers).toEqual([]);
    const prompt = judgePrompt(prepared, true).map((message) => message.content).join('\n');
    expect(prompt).toContain('empty workspace');
    expect(prompt).not.toContain('W3.');
  });
});

describe('judge reply parsing and scoring', () => {
  const report = parseReport(reportMarkdown);
  const prepared = prepareTopic(topic, evidenceForTopic(report, 'Counter staffing'), false);

  it('computes hits, misses and false alarms per category', () => {
    const verdict = scoreTopic(prepared, parseJudgeReply(validReply, prepared), false);
    expect(verdict.shouldNote.hits).toHaveLength(2);
    expect(verdict.shouldNote.misses).toHaveLength(0);
    expect(verdict.shouldNote.falseAlarms.map((item) => item.id)).toEqual(['T2']);
    expect(verdict.shouldWingman.hits).toHaveLength(2);
    expect(verdict.shouldWingman.misses).toHaveLength(1);
    expect(verdict.shouldWingman.falseAlarms).toHaveLength(0);
    expect(verdict.shouldOfferTool.hits).toHaveLength(1);
    expect(verdict.shouldOfferTool.misses).toHaveLength(1);
    expect(verdict.shouldStaySilent.falseAlarms).toEqual([{ id: 'T2', text: expect.stringContaining('Thank the team'), reason: 'Thanking the team is small talk with no concrete deliverable.' }]);
    expect(verdict.shouldNote.recall).toBe(1);
    expect(verdict.shouldWingman.recall).toBeCloseTo(2 / 3);
    expect(verdict.shouldOfferTool.recall).toBe(0.5);
    expect(verdict.notetaker).toEqual({ decisions: 1, todos: 2, minutes: true });
  });

  it('leaves a key item out of recall when its moment never occurred', () => {
    const reply = JSON.parse(validReply);
    reply.shouldWingman[0] = { gold: 1, applicable: false, found: null, reason: 'The guest was never asked by name.' };
    const verdict = scoreTopic(prepared, parseJudgeReply(JSON.stringify(reply), prepared), false);
    expect(verdict.shouldWingman.notApplicable).toHaveLength(1);
    expect(verdict.shouldWingman.misses).toHaveLength(0);
    expect(verdict.shouldWingman.hits).toHaveLength(2);
    expect(verdict.shouldWingman.recall).toBe(1);
  });

  it('totals recall and silence alarms as plain numbers', () => {
    const verdict = scoreTopic(prepared, parseJudgeReply(validReply, prepared), false);
    const totals = summarizeVerdicts([verdict, verdict]);
    expect(totals.shouldNote).toEqual({ gold: 4, applicable: 4, hits: 4, misses: 0, notApplicable: 0, falseAlarms: 2, recall: 1 });
    expect(totals.shouldWingman).toEqual({ gold: 6, applicable: 6, hits: 4, misses: 2, notApplicable: 0, falseAlarms: 0, recall: 4 / 6 });
    expect(totals.shouldOfferTool).toEqual({ gold: 4, applicable: 4, hits: 2, misses: 2, notApplicable: 0, falseAlarms: 0, recall: 0.5 });
    expect(totals.shouldStaySilent.falseAlarms).toBe(2);
    expect(totals.notetaker).toEqual({ decisions: 2, todos: 4, minutesPresent: 2, topics: 2 });
  });

  it('renders per-category counts and plain-number totals', () => {
    const verdict = scoreTopic(prepared, parseJudgeReply(validReply, prepared), false);
    const rendered = renderVerdict(verdict).join('\n');
    expect(rendered).toContain('shouldNote: 2 hit(s), 0 miss(es), 0 not applicable, 1 false alarm(s) (recall 1.00)');
    expect(rendered).toContain('false alarm: [T2] Thank the team');
    const totals = renderTotals(summarizeVerdicts([verdict])).join('\n');
    expect(totals).toContain('shouldWingman: recall 2/3 = 0.67');
    expect(totals).toContain('shouldStaySilent: 1 false alarm(s)');
    expect(totals).toContain('minutes present in 1/1 topic(s)');
  });

  it('rejects replies with the wrong shape or ids instead of guessing', () => {
    expect(() => parseJudgeReply('{oops', prepared)).toThrow(/not valid JSON/);
    const missing = JSON.parse(validReply);
    delete missing.shouldStaySilent;
    expect(() => parseJudgeReply(JSON.stringify(missing), prepared)).toThrow(/missing the "shouldStaySilent" list/);
    const wrongOrder = JSON.parse(validReply);
    wrongOrder.shouldNote[0].gold = 2;
    expect(() => parseJudgeReply(JSON.stringify(wrongOrder), prepared)).toThrow(/shouldNote\[0\]\.gold must be 1/);
    const short = JSON.parse(validReply);
    short.shouldWingman.pop();
    expect(() => parseJudgeReply(JSON.stringify(short), prepared)).toThrow(/2 shouldWingman entries for 3 key items/);
    const stray = JSON.parse(validReply);
    stray.shouldNote[0].found = 'W1';
    expect(() => parseJudgeReply(JSON.stringify(stray), prepared)).toThrow(/shouldNote\[0\]\.found must be null or one of the shown ids/);
    const missingApplicable = JSON.parse(validReply);
    delete missingApplicable.shouldNote[0].applicable;
    expect(() => parseJudgeReply(JSON.stringify(missingApplicable), prepared)).toThrow(/shouldNote\[0\]\.applicable must be true or false/);
    const inconsistent = JSON.parse(validReply);
    inconsistent.shouldNote[0].applicable = false;
    expect(() => parseJudgeReply(JSON.stringify(inconsistent), prepared)).toThrow(/found must be null when applicable is false/);
    const repeated = JSON.parse(validReply);
    repeated.shouldStaySilent.push({ found: 'T2', reason: 'again' });
    expect(() => parseJudgeReply(JSON.stringify(repeated), prepared)).toThrow(/more than once/);
  });

  it('honours the empty-workspace expectation with deterministic false alarms', () => {
    const empty = prepareTopic(topic, evidenceForTopic(report, 'Counter staffing'), true);
    const reply = parseJudgeReply(JSON.stringify({
      shouldNote: [
        { gold: 1, applicable: true, found: 'D1', reason: 'The decision is recorded.' },
        { gold: 2, applicable: true, found: 'T1', reason: 'The to-do is recorded.' },
      ],
      shouldWingman: [
        { gold: 1, applicable: true, found: null, reason: 'Nobody asked the guest directly.' },
        { gold: 2, applicable: true, found: 'W1', reason: 'The guest was handed a to-do.' },
      ],
      shouldOfferTool: [],
      shouldStaySilent: [],
    }), empty);
    const verdict = scoreTopic(empty, reply, true);
    expect(verdict.shouldNote.falseAlarms.map((item) => item.id)).toEqual(['T2']);
    expect(verdict.shouldWingman.hits).toHaveLength(1);
    expect(verdict.shouldWingman.falseAlarms.map((item) => item.id)).toEqual(['W2', 'W3']);
    expect(verdict.shouldOfferTool.goldCount).toBe(0);
    expect(verdict.shouldOfferTool.recall).toBeNull();
    expect(verdict.shouldOfferTool.falseAlarms.map((item) => item.id)).toEqual(['O1']);
    expect(verdict.shouldStaySilent.falseAlarms.map((item) => item.id)).toEqual(['W2', 'W3', 'O1']);
    expect(verdict.notetaker.minutes).toBe(true);
  });
});
