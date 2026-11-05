import { describe, expect, it } from 'vitest';
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

function setup(reply: string | Error, plays = true) {
  const said: string[] = [];
  const sent: Array<[string, KakiCommand]> = [];
  let finish: (() => void) | undefined;
  const responder = createTaskResponder({
    scenario,
    llm: { complete: async () => { if (reply instanceof Error) throw reply; return reply; } },
    plays: () => plays,
    say: (_who, text, onDone) => { said.push(text); finish = onDone; },
    send: (role, command) => sent.push([role, command]),
  });
  return { responder, said, sent, finish: () => finish?.() };
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

  it('approves the draft once it is ready', () => {
    const { responder, sent } = setup('{}');
    const draft = { target: 'a@b.c', subject: 's', body: 'b' };
    responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
    responder.handle(updated(task({ status: 'DRAFT_READY', draft })));
    expect(sent).toEqual([['chef', { type: 'APPROVE_ACTION', taskId: 't-1', draft }]]);
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
