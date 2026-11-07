import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { createNotetaker, parseNotetakerReply } from '../../src/host/notetaker';
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
async function openThenClose(evidence: string, secondPassLine: string) {
  const replies = [
    reply({ newQuestions: [{ text: 'When is the delivery due?' }] }),
    reply({ answeredQuestions: [{ id: 'q-1', evidence }] }),
  ];
  const notetaker = createNotetaker({
    scenario,
    tasks: createTaskStore({ hub: quietHub, scenario }),
    llm: createFakeLlm((_messages, call) => replies[call]!),
    agendaIndex: () => 0,
  });
  notetaker.addChunk({ speaker: 'Mei', text: 'When is the delivery due, does anyone know?' });
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

  it('parses answeredQuestions and leaves the key out when there are none', () => {
    const parsed = parseNotetakerReply(
      reply({ answeredQuestions: [{ id: 'q-1', evidence: 'x y z' }, { id: 3 }, 'nope'] }),
      scenario,
    );
    expect(parsed.answeredQuestions).toEqual([{ id: 'q-1', evidence: 'x y z' }]);
    expect('answeredQuestions' in parseNotetakerReply(reply({}), scenario)).toBe(false);
  });
});
