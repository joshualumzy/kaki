import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import {
  answerMatchesQuestion,
  createNotetaker,
  isAffirmativeAnswer,
  parseNotetakerReply,
} from '../../src/host/notetaker';
import { createFakeLlm } from '../../src/llm';
import { loadScenario } from '../../src/loadScenario';
import { createTaskStore } from '../../src/tasks';

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
  return JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [], ...body });
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
      llm: createFakeLlm((_messages, call) => replies[call]!), agendaIndex: () => 0 });
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
