import { describe, expect, it, vi } from 'vitest';
import type { KakiCommand, KakiEvent, Task } from '@kaki/shared';
import { createTaskResponder, parseDecision } from '../../src/npc/taskResponder';
import { testScenario } from '../fixtures/scenario';

const chef = testScenario.attendees.find((a) => a.role === 'chef')!;
const scenario = {
  ...testScenario,
  npcs: [{ attendee: chef.name, voice: 'v', personality: 'Blunt.', agenda: 'Keep the oven safe.', concerns: ['fuses'] }],
};

function task(overrides: Partial<Task>): Task {
  return {
    id: 't-1',
    title: 'Fix the oven',
    context: 'Trips the fuse.',
    suggestedAssignee: 'chef',
    assignee: 'chef',
    status: 'DISPATCHED',
    ...overrides,
  } as Task;
}
const updated = (t: Task): KakiEvent => ({ type: 'TASK_UPDATED', payload: { task: t }, audience: { kind: 'screen' } });

function setup(reply: string | Error, plays = true, draftOnly = false, volunteered = false) {
  const said: string[] = [];
  const sent: Array<[string, KakiCommand]> = [];
  let finish: (() => void) | undefined;
  let calls = 0;
  const prompts: string[] = [];
  const responder = createTaskResponder({
    scenario,
    llm: { complete: async (messages) => {
      calls += 1;
      prompts.push(messages.map((message) => message.content).join('\n'));
      if (reply instanceof Error) throw reply;
      return reply;
    } },
    plays: () => plays,
    volunteeredOnTopic: () => volunteered,
    say: (_who, text, onDone) => { said.push(text); finish = onDone; },
    send: (role, command) => sent.push([role, command]),
    approveDelayMs: 20,
    draftOnly,
  });
  return { responder, said, sent, prompts, calls: () => calls, finish: () => finish?.() };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('parseDecision', () => {
  it('needs a boolean and a spoken line', () => {
    expect(parseDecision('{"accept": false, "line": " No, too busy. "}')).toEqual({ accept: false, line: 'No, too busy.' });
    expect(parseDecision('{"accept": "yes", "line": "ok"}')).toBeUndefined();
    expect(parseDecision('not json')).toBeUndefined();
  });
});

describe('task responder for an AI attendee', () => {
  it('gives the character their own facts to react from, and asks for a reaction before the decision', async () => {
    let prompt = '';
    const withFacts = {
      ...scenario,
      roles: scenario.roles.map((role) => (role.id === 'chef' ? { ...role, card: { youAre: 'You are the chef.', facts: ['The oven trips the fuse twice a week.'], responsibility: 'The kitchen.' } } : role)),
      agenda: [{ ...scenario.agenda[0]!, seatFacts: { chef: 'The current item has a late delivery.' } }],
    };
    const responder = createTaskResponder({
      scenario: withFacts,
      llm: { complete: async (messages) => { prompt = messages.map((m) => m.content).join('\n'); return '{"accept": true, "line": "ok"}'; } },
      plays: () => true,
      volunteeredOnTopic: () => false,
      say: () => undefined,
      send: () => undefined,
    });
    responder.handle(updated(task({ agendaItemTitle: 'Prep' })));
    await tick();
    expect(prompt).toContain('Things you know: The current item has a late delivery.');
    expect(prompt).not.toContain('The oven trips the fuse twice a week.');
    expect(prompt).toContain('concrete detail');
    expect(prompt).toContain('never ask a question');
  });

  it('never pulls a fact from an agenda item absent from this meeting', async () => {
    let prompt = '';
    const responder = createTaskResponder({
      scenario: { ...scenario, agenda: [{ ...scenario.agenda[0]!, seatFacts: { chef: 'present item fact' } }] },
      llm: { complete: async (messages) => { prompt = messages.map((m) => m.content).join('\n'); return '{"accept": true, "line": "I will take it."}'; } },
      plays: () => true, volunteeredOnTopic: () => false, say: () => undefined, send: () => undefined,
    });
    responder.handle(updated(task({ agendaItemTitle: 'Absent' })));
    await tick();
    expect(prompt).not.toContain('present item fact');
  });

  it('speaks first, then accepts, so the screen follows the words', async () => {
    const { responder, said, sent, finish } = setup('{"accept": true, "line": "Yes, I will fix it."}');
    responder.handle(updated(task({ actionKind: 'email' })));
    await tick();
    expect(said).toEqual(['Yes, I will fix it.']);
    expect(sent).toEqual([]);
    finish();
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'ACTION_AGENT' }]]);
  });

  it('claims by hand when the task has no action to run', async () => {
    const { responder, sent, finish } = setup('{"accept": true, "line": "On it."}');
    responder.handle(updated(task({})));
    await tick();
    finish();
    expect(sent[0]![1]).toMatchObject({ type: 'CLAIM_TASK', mode: 'MANUAL' });
  });

  it('declines when the character says no', async () => {
    const { responder, said, sent, finish } = setup('{"accept": false, "line": "Not mine, ask Ben."}');
    responder.handle(updated(task({})));
    await tick();
    finish();
    expect(said).toEqual(['Not mine, ask Ben.']);
    expect(sent).toEqual([['chef', { type: 'DECLINE_TASK', taskId: 't-1' }]]);
  });

  it.each([
    'I will fix the oven this afternoon.',
    "I'll fix the oven this afternoon.",
    "I'm going to fix the oven this afternoon.",
    'I, Ada, will fix the oven this afternoon.',
    'Sure, I will fix the oven this afternoon.',
  ])('honours an unchanged self-volunteered task silently, without asking the model: %s', async (quote) => {
    const { responder, said, sent, calls } = setup('{"accept": false, "line": "Not mine, ask Bao."}');
    responder.handle(
      updated(
        task({
          assignmentEvidence: {
            speaker: 'Ada (Chef)',
            quote,
            scope: { title: 'Fix the oven', context: 'Trips the fuse.' },
          },
        }),
      ),
    );
    await tick();
    expect(calls()).toBe(0);
    expect(said).toEqual([]);
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  it('claims silently when the colleague already offered aloud on this topic, without asking the model', async () => {
    const { responder, said, sent, calls } = setup('{"accept": false, "line": "Not mine."}', true, false, true);
    responder.handle(updated(task({})));
    await tick();
    expect(calls()).toBe(0);
    expect(said).toEqual([]);
    expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'MANUAL' }]]);
  });

  const commitment = 'I will fix the oven this afternoon.';
  const scope = { title: 'Fix the oven', context: 'Trips the fuse.' };
  const evidence = (quote: string, speaker = 'Ada (Chef)') => ({ speaker, quote, scope });
  it.each([
    ['no evidence', {}],
    ['a different speaker role', { assignmentEvidence: evidence(commitment, 'Bao (Cashier)') }],
    ['an invalid speaker', { assignmentEvidence: evidence(commitment, '  ') }],
    ['a negated commitment', { assignmentEvidence: evidence('I will not fix the oven this afternoon.') }],
    ['a refusal', { assignmentEvidence: evidence("No, I won't fix the oven this afternoon, but I will ask about it.") }],
    ['a conditional commitment', { assignmentEvidence: evidence('If approved I will fix the oven this afternoon.') }],
    ['a conditional clause after the commitment', { assignmentEvidence: evidence('I will fix the oven if approved.') }],
    ['a hypothetical commitment', { assignmentEvidence: evidence('Maybe I will fix the oven this afternoon.') }],
    ['a question', { assignmentEvidence: evidence('Do you think I will fix the oven this afternoon?') }],
    ['quoted speech', { assignmentEvidence: evidence('"I will fix the oven this afternoon."') }],
    ['reported speech', { assignmentEvidence: evidence('Ada said I will fix the oven this afternoon.') }],
    ['a delegated commitment', { assignmentEvidence: evidence('I will ask Bao to fix the oven this afternoon.') }],
    ['a changed title', { title: 'Replace the oven', assignmentEvidence: evidence(commitment) }],
    ['a changed context', { context: 'Trips the power.', assignmentEvidence: evidence(commitment) }],
    ['a changed action', { actionKind: 'email', assignmentEvidence: evidence(commitment) }],
  ] satisfies Array<[string, Partial<Task>]>)(
    'still leaves the decision to the character for %s', async (_label, overrides) => {
    const { responder, said, sent, calls, finish } = setup('{"accept": false, "line": "That is not mine."}');
    responder.handle(updated(task(overrides)));
    await tick();
    expect(calls()).toBe(1);
    expect(said).toEqual(['That is not mine.']);
    finish();
    expect(sent).toEqual([['chef', { type: 'DECLINE_TASK', taskId: 't-1' }]]);
    },
  );

  it('accepts when the model fails, so the meeting is not left waiting', async () => {
    const { responder, sent, finish } = setup(new Error('timeout'));
    responder.handle(updated(task({})));
    await tick();
    finish();
    expect(sent[0]![1]).toMatchObject({ type: 'CLAIM_TASK' });
  });

  it('answers a task once, but again if it is offered again after a decline', async () => {
    const { responder, said } = setup('{"accept": false, "line": "No."}');
    responder.handle(updated(task({})));
    responder.handle(updated(task({})));
    await tick();
    expect(said).toHaveLength(1);
    responder.handle(updated(task({ status: 'SUGGESTED', assignee: undefined })));
    responder.handle(updated(task({})));
    await tick();
    expect(said).toHaveLength(2);
  });

  it('approves the draft once it is ready, after a pause like a person reading it', async () => {
    const { responder, sent } = setup('{}');
    const draft = { target: 'a@b.c', subject: 's', body: 'b' };
    responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
    responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
    expect(sent).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sent).toEqual([['chef', { type: 'APPROVE_ACTION', taskId: 't-1', draft }]]);
  });

  it('in draftOnly mode still claims, but never auto-approves or retries a draft', async () => {
    vi.useFakeTimers();
    try {
      const { responder, sent, finish } = setup('{"accept": true, "line": "On it."}', true, true);
      const draft = { target: 'a@b.c', subject: 's', body: 'b' };
      responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
      responder.handle(updated(task({ status: 'FAILED', draft, error: 'not sent' })));
      await vi.advanceTimersByTimeAsync(3_100);
      expect(sent).toEqual([]);

      responder.handle(updated(task({ actionKind: 'email' })));
      await vi.advanceTimersByTimeAsync(0);
      finish();
      expect(sent).toEqual([['chef', { type: 'CLAIM_TASK', taskId: 't-1', mode: 'ACTION_AGENT' }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the task alone when a person has taken that seat', async () => {
    const { responder, said, sent } = setup('{"accept": true, "line": "x"}', false);
    responder.handle(updated(task({})));
    responder.handle(updated(task({ status: 'DRAFT_READY', draft: { target: 't', subject: 's', body: 'b' } })));
    await tick();
    expect(said).toEqual([]);
    expect(sent).toEqual([]);
  });
});
