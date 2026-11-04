import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { createNotetaker, volunteerRole } from '../../src/host/notetaker';
import { createFakeLlm } from '../../src/llm';
import { loadScenario } from '../../src/loadScenario';
import { createTaskStore } from '../../src/tasks';

const quietHub: Hub = {
  publish: (_event: KakiEvent) => {},
  subscribe: () => () => {},
  onCommand: () => {},
  close: () => {},
};

let scenario: Scenario;
beforeAll(async () => {
  scenario = await loadScenario('pixel-kampung');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// One pass: `speaker` says `line`, and the model proposes a task for `modelAssignee` quoting that line.
async function assigneeAfter(speaker: string, line: string, modelAssignee: string): Promise<string | undefined> {
  const tasks = createTaskStore({ hub: quietHub, scenario });
  const notetaker = createNotetaker({
    scenario,
    tasks,
    llm: createFakeLlm(() =>
      JSON.stringify({
        newQuestions: [],
        answeredQuestionIds: [],
        newTasks: [{ title: 'Send the update', context: 'c', suggestedAssignee: modelAssignee, actionKind: 'email', evidence: line }],
      }),
    ),
    agendaIndex: () => 0,
  });
  notetaker.addChunk({ speaker, text: line });
  await notetaker.run();
  return tasks.list()[0]?.suggestedAssignee;
}

describe('who owns a task', () => {
  it('is the speaker when the evidence is their own "I\'ll ..."', async () => {
    expect(await assigneeAfter('Wei Ling', "I'll send the update to the venue tonight.", 'marketing_lead')).toBe('producer');
  });

  it('is the role the model chose when someone else is asked', async () => {
    expect(await assigneeAfter('Wei Ling', 'Daniel, can you send the update to the venue tonight?', 'marketing_lead')).toBe(
      'marketing_lead',
    );
  });

  it('is the role the model chose when the speaker has no known role', async () => {
    expect(await assigneeAfter('Visitor', "I'll send the update to the venue tonight.", 'marketing_lead')).toBe('marketing_lead');
  });

  it('volunteerRole needs both a commitment and a known role', () => {
    expect(volunteerRole("Yes, I'll file it today.", { role: 'lead_programmer' })).toBe('lead_programmer');
    expect(volunteerRole("Yes, I'll file it today.", {})).toBeUndefined();
    expect(volunteerRole('Can you file it today?', { role: 'producer' })).toBeUndefined();
  });
});

describe('what the notetaker is told about the scenario', () => {
  async function systemPromptFor(withContext: Scenario): Promise<string> {
    let system = '';
    const notetaker = createNotetaker({
      scenario: withContext,
      tasks: createTaskStore({ hub: quietHub, scenario: withContext }),
      llm: createFakeLlm((messages) => {
        system = messages.find((message) => message.role === 'system')?.content ?? '';
        return JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [] });
      }),
      agendaIndex: () => 0,
    });
    notetaker.addChunk({ speaker: 'Wei Ling', text: 'Okay, everyone is here.' });
    await notetaker.run();
    return system;
  }

  it('includes the situation and the vocabulary as background', async () => {
    const system = await systemPromptFor({ ...scenario, situation: 'A small team is preparing a launch.', vocabulary: ['widget', 'rollout plan'] });
    expect(system).toContain('A small team is preparing a launch.');
    expect(system).toContain('never from this');
    expect(system).toContain('widget, rollout plan');
  });

  it('leaves both out when the scenario has neither', async () => {
    const { situation: _situation, vocabulary: _vocabulary, ...bare } = scenario;
    const system = await systemPromptFor(bare);
    expect(system).not.toContain('Background');
    expect(system).not.toContain('likely to come up');
  });
});
