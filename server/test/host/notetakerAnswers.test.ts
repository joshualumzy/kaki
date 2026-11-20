import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/core/hub';
import {
  answerMatchesQuestion,
  createNotetaker,
  isAffirmativeAnswer,
  parseNotetakerReply,
  taskMatchesAssignment,
  type AnswerCandidate,
  type ResolvedTaskCandidate,
  type VerifierResult,
} from '../../src/host/notetaker';
import { createFakeLlm } from '../../src/services/llm';
import { loadScenario } from '../../src/core/loadScenario';
import { createTaskStore } from '../../src/meeting/tasks';

const quietHub: Hub = {
  publish: (_event: KakiEvent) => {},
  subscribe: () => () => {},
  onCommand: () => {},
  clearRetained: () => {},
  close: () => {},
};

let scenario: Scenario;
beforeAll(async () => {
  scenario = await loadScenario('kopitiam');
});

function reply(body: Record<string, unknown>): string {
  return JSON.stringify({
    newQuestions: [],
    answeredQuestionIds: [],
    answeredQuestions: [],
    newTasks: [],
    revisions: [],
    ...body,
  });
}

/** The old lexical answer verdicts, for the tests that cover grounding rather than the verifier's meaning check. */
async function lexicalVerify(answers: AnswerCandidate[], tasks: ResolvedTaskCandidate[]): Promise<VerifierResult> {
  return {
    answers: new Map(
      answers.map((answer) => [
        answer.id,
        isAffirmativeAnswer(answer.source.text) && answerMatchesQuestion(answer.question.text, answer.source.text)
          ? 'yes'
          : 'no',
      ]),
    ),
    tasks: new Map(
      tasks.map((candidate) => [
        candidate.index,
        {
          verdict: taskMatchesAssignment(candidate.task, candidate.source) ? 'yes' : 'no',
          assigneeRole: taskMatchesAssignment(candidate.task, candidate.source)
            ? (candidate.lexicalOwner ?? candidate.task.suggestedAssignee)
            : null,
        },
      ]),
    ),
    issues: [],
  };
}

// Pass 1 asks a question; pass 2 tries to close it with the given evidence.
async function openThenClose(evidence: string, secondPassLine: string, question = 'When is the delivery due?') {
  return openThenReply(reply({ answeredQuestions: [{ id: 'q-1', evidence }] }), secondPassLine, question);
}

async function openThenReply(secondReply: string, secondPassLine: string, question = 'When is the delivery due?') {
  const replies = [reply({ newQuestions: [{ text: question }] }), secondReply];
  const notetaker = createNotetaker({
    scenario: () => scenario,
    tasks: createTaskStore({ hub: quietHub, scenario }),
    llm: createFakeLlm((_messages, call) => replies[call]!),
    verify: lexicalVerify,
    agendaIndex: () => 0,
  });
  notetaker.addChunk({ speaker: 'Mei', text: question });
  await notetaker.run();
  notetaker.addChunk({ speaker: 'Arjun', text: secondPassLine });
  await notetaker.run();
  return notetaker.state().openQuestions;
}

describe('closing a question needs the line that answers it', () => {
  it('closes it when the evidence is a line from the new transcript', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await openThenClose('The delivery is due on Monday morning.', 'The delivery is due on Monday morning.')).toEqual([]);
  });

  it('keeps it open when the evidence is not in the new transcript', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = await openThenClose('The delivery is due on Monday morning.', 'Let us move on to the budget.');
    expect(open.map((question) => question.text)).toEqual(['When is the delivery due?']);
  });

  it('keeps it open when grounded evidence states an unrelated fact', async () => {
    const line = 'The kiosk has twelve buttons on each page.';
    const open = await openThenClose(line, line);
    expect(open.map((question) => question.text)).toEqual(['When is the delivery due?']);
  });

  it('keeps it open when an unrelated fact shares a number with the question', async () => {
    const replies = [
      reply({ newQuestions: [{ text: 'Does the twelve-button grid support a clearer drink label?' }] }),
      reply({ answeredQuestions: [{ id: 'q-1', evidence: 'Our twelve-gram butter slab did not shrink.' }] }),
    ];
    const notetaker = createNotetaker({ scenario: () => scenario, tasks: createTaskStore({ hub: quietHub, scenario }),
      llm: createFakeLlm((_messages, call) => replies[call]!), verify: lexicalVerify, agendaIndex: () => 0 });
    notetaker.addChunk({ speaker: 'Mei', text: 'Does the twelve-button grid support a clearer drink label?' });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Mei', text: 'Our twelve-gram butter slab did not shrink.' });
    await notetaker.run();
    expect(notetaker.state().openQuestions).toHaveLength(1);
  });

  it('keeps it open when the reply only names the id without evidence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = await openThenReply(reply({ answeredQuestionIds: ['q-1'] }), 'The delivery is due on Monday morning.');
    expect(open.map((question) => question.text)).toEqual(['When is the delivery due?']);
  });

  it.each([
    "The trial sheet has that split, but I haven't looked at it since the trial.",
    'Not per hour. The trial sheet has the split, but I would have to check it.',
    'That is still open. Nothing we have can take cash tomorrow without a free pair of hands.',
    'Right, keep the portion open for now.',
    "I don't know if it fits the twelve-button grid.",
    'The email says Monday, but I think it moved, so don\'t quote me.',
    "Okay, let's not decide blind. Put the per-hour solo diner number on the list.",
    "I can pull the socket usage from the relay, but that won't tell us who is a camper.",
  ])('keeps it open when the quoted line is uncertain: %s', async (line) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = await openThenClose(line, line);
    expect(open.map((question) => question.text)).toEqual(['When is the delivery due?']);
  });

  it.each([
    ['How is change counted and balanced at close?', 'We change the menu every week.'],
    ['When is the delivery due?', 'The delivery van broke down.'],
    ['How many solo diners need a table between eight and ten?', 'Solo diners get a discount at lunch.'],
    ['When will Zack send the rates?', 'Zack is on leave next week.'],
    ['Does the twelve-button grid support a clearer drink label?', 'The grid layout is printed on the wall.'],
  ])('keeps it open when the quoted line only shares a topic word: %s / %s', async (question, line) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const open = await openThenClose(line, line, question);
    expect(open.map((item) => item.text)).toEqual([question]);
  });

  it('closes a who question when the reply names who does it', async () => {
    const question = 'Who enforces any new seating rule if it cannot be Auntie Mary?';
    const line = 'The floor managers will enforce it.';
    const open = await openThenClose(line, line, question);
    expect(open).toEqual([]);
  });

  it('parses answeredQuestions and leaves the key out when there are none', () => {
    const parsed = parseNotetakerReply(
      reply({ answeredQuestions: [{ id: 'q-1', evidence: 'x y z' }, { id: 3 }, 'nope'] }),
      scenario,
    );
    expect(parsed.answeredQuestions).toEqual([{ id: 'q-1', evidence: 'x y z' }]);
    expect('answeredQuestions' in parseNotetakerReply(reply({}), scenario)).toBe(false);
  });
});

describe('semantic verifier for answers', () => {
  const verifierReply = (payload: { verdict: string; id?: string }) => ({
    answers: [{ id: payload.id ?? 'q-1', verdict: payload.verdict }],
    tasks: [],
  });

  async function closeWithVerdict(
    evidence: string,
    verdict: ReturnType<typeof verifierReply> | string,
    question = 'When is the delivery due?',
  ) {
    const replies = [
      reply({ newQuestions: [{ text: question }] }),
      reply({ answeredQuestions: [{ id: 'q-1', evidence }] }),
    ];
    const verifier =
      typeof verdict === 'string'
        ? createFakeLlm(() => verdict)
        : createFakeLlm(() => JSON.stringify(verdict));
    const notetaker = createNotetaker({
      scenario: () => scenario,
      tasks: createTaskStore({ hub: quietHub, scenario }),
      llm: createFakeLlm((_messages, call) => replies[call]!),
      verifier,
      agendaIndex: () => 0,
    });
    notetaker.addChunk({ speaker: 'Mei', text: question });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Arjun', text: evidence });
    await notetaker.run();
    return { state: notetaker.state(), verifier };
  }

  it('closes a question on a paraphrase the lexical check would not accept', async () => {
    const { state } = await closeWithVerdict('It lands on Monday morning.', verifierReply({ verdict: 'yes' }));
    expect(state.openQuestions).toEqual([]);
    expect(state.reviewIssues).toEqual([]);
  });

  it('keeps a question open when the verifier says the shared words are misleading', async () => {
    const question = 'How is change counted and balanced at close?';
    const { state } = await closeWithVerdict(
      'The change float is balanced every week by the floor manager.',
      verifierReply({ verdict: 'no' }),
      question,
    );
    expect(state.openQuestions.map((item) => item.text)).toEqual([question]);
    expect(state.reviewIssues).toEqual([]);
  });

  it('leaves an uncertain answer open with a visible issue', async () => {
    const { state } = await closeWithVerdict(
      'It should land on Monday, maybe.',
      verifierReply({ verdict: 'unclear' }),
    );
    expect(state.openQuestions.map((item) => item.text)).toEqual(['When is the delivery due?']);
    expect(state.reviewIssues.some((issue) => issue.text.includes('Could not confirm whether the question'))).toBe(true);
  });

  it('keeps the batch pending when the verifier reply is unreadable, instead of treating it as a verdict', async () => {
    const { state, verifier } = await closeWithVerdict('The delivery is due on Monday morning.', 'not json');
    expect(verifier.calls).toHaveLength(2);
    expect(state.openQuestions.map((item) => item.text)).toEqual(['When is the delivery due?']);
    expect(state.reviewIssues).toEqual([]);
    expect(state.status).toBe('stale');
  });

  it('never invokes the verifier when the guest supplies no evidence', async () => {
    const replies = [
      reply({ newQuestions: [{ text: 'When is the delivery due?' }] }),
      reply({}),
    ];
    const verifier = createFakeLlm(() => {
      throw new Error('the verifier should not be called');
    });
    const notetaker = createNotetaker({
      scenario: () => scenario,
      tasks: createTaskStore({ hub: quietHub, scenario }),
      llm: createFakeLlm((_messages, call) => replies[call]!),
      verifier,
      agendaIndex: () => 0,
    });
    notetaker.addChunk({ speaker: 'Mei', text: 'When is the delivery due?' });
    await notetaker.run();
    notetaker.addChunk({ speaker: 'Arjun', text: 'Let us move on to the budget.' });
    await notetaker.run();

    expect(verifier.calls).toHaveLength(0);
    expect(notetaker.state().openQuestions.map((item) => item.text)).toEqual(['When is the delivery due?']);
    expect(notetaker.state().reviewIssues).toEqual([]);
  });
});

describe('answerMatchesQuestion', () => {
  it.each([
    ['When is the delivery due?', 'The delivery is due on Monday morning.'],
    ['Where do players quit?', 'Players quit at the second level.'],
    ['Who runs cash at the kiosk?', 'Arjun runs cash at the kiosk on weekdays.'],
    ['Who enforces any new seating rule if it cannot be Auntie Mary?', 'The floor managers will enforce it.'],
    ['How is change counted and balanced at close?', 'Change is counted at close and the float is balanced.'],
  ])('accepts an answer that shares the question\'s topic: %s / %s', (question, answer) => {
    expect(answerMatchesQuestion(question, answer)).toBe(true);
  });

  it.each([
    ['How is change counted and balanced at close?', 'We change the menu every week.'],
    ['When is the delivery due?', 'The delivery van broke down.'],
    ['How many solo diners need a table between eight and ten?', 'Solo diners get a discount at lunch.'],
    ['When will Zack send the rates?', 'Zack is on leave next week.'],
    ['Does the twelve-button grid support a clearer drink label?', 'The grid layout is printed on the wall.'],
  ])('rejects a line that only shares a subject word: %s / %s', (question, answer) => {
    expect(answerMatchesQuestion(question, answer)).toBe(false);
  });
});

describe('an affirmative answer states the fact', () => {
  it.each([
    'We can confirm the date is Monday.',
    'The float is not per hour, it is per shift.',
    'The delivery is due on Monday morning.',
    "Yesterday's trial had 28 first-time users.",
  ])('accepts: %s', (line) => {
    expect(isAffirmativeAnswer(line)).toBe(true);
  });

  it.each([
    "Okay, let's not decide blind. Put the per-hour solo diner number on the list.",
    "I can pull the socket usage from the relay, but that won't tell us who is a camper.",
    'Right, keep the portion open for now.',
    "The trial sheet has that split, but I haven't looked at it since the trial.",
    'That is still open. Nothing we have can take cash tomorrow without a free pair of hands.',
    "I don't know if it fits the twelve-button grid.",
  ])('rejects: %s', (line) => {
    expect(isAffirmativeAnswer(line)).toBe(false);
  });
});
