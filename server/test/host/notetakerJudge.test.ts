import { describe, expect, it } from 'vitest';
import {
  judgeNotetaker,
  notetakerFailures,
  type ExpectedNotetakerItems,
  type FoundQuestion,
  type FoundTask,
  type NotetakerJudgeVerdict,
} from '../../src/host/eval/judgeNotetaker';
import { createFakeLlm } from '../../src/services/llm';

const expected: ExpectedNotetakerItems = {
  tasks: [
    { name: "regulars' note", assignee: 'menu_store_lead' },
    { name: 'booth socket timer', assignee: 'tech_pos_lead' },
  ],
  acceptedTasks: [{ name: 'customer email and logs', assignee: 'operations_director' }],
  questions: [{ name: 'who covers the counter if Auntie Mary says no' }],
};

const foundTasks: FoundTask[] = [
  {
    title: 'Draft the regulars note',
    context: 'Write the note for the counter and Facebook.',
    suggestedAssignee: 'menu_store_lead',
  },
  {
    title: 'Sort the booth socket',
    context: 'Put a timer on the booth socket.',
    suggestedAssignee: 'tech_pos_lead',
  },
];

const foundQuestions: FoundQuestion[] = [
  { text: 'Who covers the counter when Auntie Mary is away?', forRole: 'operations_director' },
];

function userMessage(messages: Array<{ role: string; content: string }>): string {
  return messages.find((message) => message.role === 'user')?.content ?? '';
}

describe('notetaker judge', () => {
  it('asks the model to pair found and expected items by meaning', async () => {
    const prompts: string[] = [];
    const llm = createFakeLlm((messages) => {
      const user = userMessage(messages);
      prompts.push(user);
      return user.includes('Judgement: found follow-up tasks')
        ? JSON.stringify({
            matches: [
              { gold: 1, found: 1, reason: 'Both write the regulars note.' },
              { gold: 2, found: 2, reason: 'Both add the booth socket timer.' },
              { gold: 3, found: null, reason: 'Nothing sends the customer email.' },
            ],
          })
        : JSON.stringify({
            matches: [{ gold: 1, found: 1, reason: 'Both ask who covers the counter.' }],
          });
    });

    const verdict = await judgeNotetaker(llm, {
      meeting: 'Morning huddle',
      foundTasks,
      foundQuestions,
      expected,
    });

    expect(verdict.tasks.pairs).toEqual([
      { found: 1, gold: 1, reason: 'Both write the regulars note.' },
      { found: 2, gold: 2, reason: 'Both add the booth socket timer.' },
    ]);
    expect(verdict.tasks.unmatchedGold).toEqual([3]);
    expect(verdict.questions.pairs).toEqual([
      { found: 1, gold: 1, reason: 'Both ask who covers the counter.' },
    ]);
    const prompt = prompts.join('\n');
    expect(prompt).toContain('Draft the regulars note — Write the note for the counter and Facebook.');
    expect(prompt).toContain("regulars' note (owner: menu_store_lead)");
    expect(prompt).toContain('Who covers the counter when Auntie Mary is away?');
  });

  it('reports missing required tasks and questions, but not an unfound accepted task', () => {
    const verdict: NotetakerJudgeVerdict = {
      tasks: {
        pairs: [{ found: 1, gold: 1, reason: 'same work' }],
        unmatchedFound: [3],
        unmatchedGold: [2, 3],
      },
      questions: {
        pairs: [],
        unmatchedFound: [],
        unmatchedGold: [1],
      },
    };

    expect(
      notetakerFailures(
        expected,
        {
          tasks: [...foundTasks, { title: 'Invented extra card', context: '', suggestedAssignee: 'chef' }],
        },
        verdict,
      ),
    ).toEqual([
      'missing task: booth socket timer',
      'unexpected task: Invented extra card',
      'missing question: who covers the counter if Auntie Mary says no',
    ]);
  });
});
