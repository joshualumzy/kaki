import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import { addressedRole, createNotetaker, volunteerRole } from '../../src/host/notetaker';
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// One pass: `speaker` says `line`, and the model proposes a task for `modelAssignee` quoting that line.
async function assigneeAfter(
  speaker: string,
  line: string,
  modelAssignee: string,
  visitorOwnerShortcut?: () => boolean,
): Promise<string | undefined> {
  const tasks = createTaskStore({ hub: quietHub, scenario });
  const notetaker = createNotetaker({
    scenario,
    tasks,
    llm: createFakeLlm(() =>
      JSON.stringify({
        newQuestions: [],
        answeredQuestionIds: [],
        newTasks: [
          { title: 'Email the venue confirmation', context: 'c', suggestedAssignee: modelAssignee, actionKind: 'email', evidence: line },
        ],
      }),
    ),
    agendaIndex: () => 0,
    ...(visitorOwnerShortcut === undefined ? {} : { visitorOwnerShortcut }),
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

  // The visitor (Wei Ling's seat, shown with their own name) asks Daniel mid-line, after stating the decision.
  const visitorLines = [{ speaker: 'Robot Visitor (Wei Ling)', role: 'producer' as const, text: 'Four window seats.' }];

  it('is the colleague the visitor names right before "can you", even mid-line', () => {
    expect(addressedRole(
      'Right, four window seats breakfast-only till 10.30 with small table signs. Daniel, can you print and place those before we open?',
      scenario, visitorLines, 'producer',
    )).toBe('marketing_lead');
  });

  it('is the visitor when a colleague asks "can you" without naming anyone', () => {
    expect(addressedRole('Sounds right. Can you post that to the team?', scenario, visitorLines, 'marketing_lead')).toBe('producer');
  });

  it('does not route an unaddressed "can you" to a visitor when two or more people are in the room', async () => {
    expect(addressedRole(
      'Can you email the venue confirmation to the team?',
      scenario, visitorLines, 'marketing_lead', { visitorShortcut: false },
    )).toBeUndefined();
    // With two humans the model's own owner stands instead of falling back to the one visitor.
    expect(await assigneeAfter(
      'Wei Ling',
      'Can you email the venue confirmation to the team?',
      'marketing_lead',
      () => false,
    )).toBe('marketing_lead');
    // The single-human demo keeps the visitor shortcut exactly as before (see the direct cases above).
    expect(addressedRole(
      'Can you email the venue confirmation to the team?',
      scenario, visitorLines, 'marketing_lead', { visitorShortcut: true },
    )).toBe('producer');
  });

  it('volunteerRole needs both a commitment and a known role', () => {
    expect(volunteerRole("Yes, I'll file it today.", { role: 'lead_programmer' })).toBe('lead_programmer');
    expect(volunteerRole("Yes, I'll file it today.", {})).toBeUndefined();
    expect(volunteerRole('Can you file it today?', { role: 'producer' })).toBeUndefined();
  });
});
