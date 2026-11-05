import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { createApp, type KakiApp } from '../../src/app';
import { createMeetingModule, openingLine } from '../../src/host/meeting';
import { createFakeLlm } from '../../src/llm';
import { testScenario } from '../fixtures/scenario';
import { connectClient, createTestApp, portOf, settle, waitFor, waitForEvent, type TestClient } from '../helpers';

const reply = (body: Record<string, unknown>) =>
  JSON.stringify({ newQuestions: [], answeredQuestionIds: [], newTasks: [], ...body });

function isRecord(event: KakiEvent): event is Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> {
  return event.type === 'MEETING_RECORD_UPDATED';
}

let app: KakiApp | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

async function connect(role: string): Promise<TestClient> {
  const client = await connectClient(portOf(app!), role);
  clients.push(client);
  return client;
}

function say(text: string): void {
  app!.hub.publish({
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'screen' },
    payload: { speaker: 'Ada (Chef)', text, timestamp: new Date().toISOString() },
  });
}

describe('host meeting module', () => {
  it('turns a replayed transcript into a meeting record and suggested tasks', async () => {
    const llm = createFakeLlm((messages) =>
      messages[1]!.content.includes('oven')
        ? reply({
            agendaIndex: 0,
            newQuestions: [{ text: 'Who services the oven?', forRole: 'chef' }],
            newTasks: [
              {
                title: 'Call the oven repair man',
                context: 'The oven trips the fuse.',
                suggestedAssignee: 'chef',
                evidence: 'The oven trips the fuse again.',
              },
            ],
          })
        : reply({}),
    );
    app = await createTestApp({
      modules: [
        createMeetingModule({
          llm,
          notetakerIntervalMs: 50,
          replay: [
            { at: 0, speaker: 'Ada (Chef)', text: 'The oven trips the fuse again.' },
            { at: 0, speaker: 'Bao (Cashier)', text: 'Who services the oven?' },
          ],
        }),
      ],
    });
    const screen = await connect('screen');
    const chef = await connect('chef');

    const suggested = await waitForEvent(
      screen,
      (event) => event.type === 'TASK_UPDATED' && event.payload.task.status === 'DISPATCHED',
      'suggested task, dispatched by the host',
    );
    // Sam hands it straight to the role the notetaker named; the recipient accepts or declines.
    expect(suggested).toMatchObject({
      payload: { task: { title: 'Call the oven repair man', suggestedAssignee: 'chef', assignee: 'chef' } },
    });
    await waitForEvent(
      chef,
      (event) => event.type === 'TASK_UPDATED' && event.payload.task.status === 'DISPATCHED',
      'the task on the chef\'s phone',
    );

    const record = await waitForEvent(
      screen,
      (event) => isRecord(event) && event.payload.openQuestions.length > 0,
      'record with a question',
    );
    expect(record).toMatchObject({
      audience: { kind: 'screen' },
      payload: {
        agendaIndex: 0,
        openQuestions: [{ id: 'q-1', text: 'Who services the oven?', forRole: 'chef' }],
        speakerTalkSeconds: { chef: 2, cashier: 2 },
      },
    });
    // Phones never get the record, so it cannot pile up there.
    expect(chef.messages.filter(isRecord)).toEqual([]);

    // A late joiner gets the latest record straight away.
    const late = await connect('screen');
    await waitForEvent(late, isRecord, 'retained record');
  });

  it('publishes nothing until the meeting has started', async () => {
    app = await createTestApp({ modules: [createMeetingModule({ notetakerIntervalMs: 50 })] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const screen = await connect('screen');

    await settle(1_200);
    expect(screen.messages.filter(isRecord)).toEqual([]);

    say('Let us begin.');
    const record = await waitForEvent(screen, isRecord, 'first record', 2_000);
    expect(record).toMatchObject({ payload: { agendaIndex: 0, openQuestions: [] } });
  });

  it('says when the notes are stale and who has been quiet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const llm = createFakeLlm(() => {
      throw new Error('gateway unreachable');
    });
    app = await createTestApp({ modules: [createMeetingModule({ llm, notetakerIntervalMs: 50 })] });
    const screen = await connect('screen');

    // Ada talks for over a minute; Bao says nothing.
    say(Array.from({ length: 160 }, () => 'word').join(' '));

    const record = await waitForEvent(
      screen,
      (event) => isRecord(event) && event.payload.notetakerStatus === 'stale',
      'stale record',
      3_000,
    );
    expect(record).toMatchObject({ payload: { quietRoles: ['cashier'], speakerTalkSeconds: { chef: 64 } } });
  });

  it('holds back unchanged records but sends a heartbeat', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // At 20x, the 30 s heartbeat comes every 1.5 real seconds.
    app = await createTestApp({ modules: [createMeetingModule({ speed: 20 })] });
    const screen = await connect('screen');
    say('Let us begin.');

    const first = await waitForEvent(screen, isRecord, 'first record', 2_000);
    expect(first).toMatchObject({ payload: { notetakerStatus: 'off', quietRoles: [] } });
    await settle(500);
    expect(screen.messages.filter(isRecord)).toHaveLength(1);

    await waitFor(() => (screen.messages.filter(isRecord).length === 2 ? true : undefined), 'heartbeat', 3_000);
  });

  it('welcomes the room before the first agenda item is announced', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    app = await createApp({
      scenario: { ...testScenario, agenda: [...testScenario.agenda, { title: 'Till', minutes: 2, ownerRole: 'cashier' }] },
      modules: [
        createMeetingModule({
          llm: createFakeLlm(() => reply({ agendaIndex: 0 })),
          speed: 20,
          notetakerIntervalMs: 50,
          replay: [
            { at: 1, speaker: 'Ada (Chef)', text: 'Prep is done, I think.', agendaIndex: 0 },
            { at: 2, speaker: 'Bao (Cashier)', text: 'On to the till then.', agendaIndex: 1 },
          ],
        }),
      ],
    });
    const screen = await connect('screen');
    await waitForEvent(
      screen,
      (event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.text.startsWith('Next up'),
      'the next-item announcement',
    );
    const spoken = screen.messages.flatMap((event) =>
      event.type === 'HOST_SPEECH_TRIGGERED' ? [event.payload.text] : [],
    );
    expect(spoken[0]).toMatch(/^Welcome to /);
  });

  it('follows the replay agenda markers and ends the meeting after the last line', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The LLM keeps saying item 0; a replay goes by its own markers instead.
    const llm = createFakeLlm(() => reply({ agendaIndex: 0 }));
    app = await createApp({
      scenario: { ...testScenario, agenda: [...testScenario.agenda, { title: 'Till', minutes: 2, ownerRole: 'cashier' }] },
      modules: [
        createMeetingModule({
          llm,
          speed: 20,
          notetakerIntervalMs: 50,
          replay: [
            { at: 0, speaker: 'Ada (Chef)', text: 'Prep is done, I think.' },
            { at: 2, speaker: 'Bao (Cashier)', text: 'On to the till then.', agendaIndex: 1 },
          ],
        }),
      ],
    });
    const screen = await connect('screen');

    const record = await waitForEvent(
      screen,
      (event) => isRecord(event) && event.payload.agendaIndex === 1,
      'record on the second item',
    );
    // Bao's line counts towards the item it opened.
    expect(record).toMatchObject({ payload: { speakerTalkSeconds: { cashier: 2 } } });

    const count = screen.messages.filter(isRecord).length;
    await settle(2_000);
    expect(screen.messages.filter(isRecord)).toHaveLength(count);
  });

  it('logs a failing record publish instead of crashing the server', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    app = await createTestApp({ modules: [createMeetingModule({ notetakerIntervalMs: 50 })] });
    const publish = app.hub.publish.bind(app.hub);
    app.hub.publish = (event, options) => {
      if (isRecord(event)) throw new Error('refused');
      publish(event, options);
    };

    say('Let us begin.');
    await waitFor(
      () => (error.mock.calls.some(([message]) => String(message).includes('kaki host:')) ? true : undefined),
      'logged failure',
      2_500,
    );
  });

  describe('ending a meeting', () => {
    it('freezes the record on END_MEETING and starts a clean meeting on the next line', async () => {
      app = await createTestApp({ modules: [createMeetingModule({ speed: 50 })] });
      app.tasks.suggest({ title: 'Old task', context: 'From the last visitor', suggestedAssignee: 'chef' });
      const screen = await connect('screen');
      say('Hello everyone.');
      await waitFor(() => (screen.messages.some(isRecord) ? true : undefined), 'first record');

      screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
      await waitFor(
        () =>
          screen.messages.some((e) => e.type === 'HOST_SPEECH_TRIGGERED' && e.payload.kind === 'CLOSING')
            ? true
            : undefined,
        'closing line',
      );
      const frozen = screen.messages.filter(isRecord).at(-1)!.payload.elapsedSeconds;
      await settle(1_300);
      const after = screen.messages.filter(isRecord);
      expect(after.at(-1)!.payload.elapsedSeconds).toBe(frozen);

      const before = screen.messages.length;
      say('Hello again, new visitor.');
      await waitFor(() => (screen.messages.slice(before).some((e) => e.type === 'MEETING_RESET') ? true : undefined), 'reset');
      expect(app.tasks.list()).toHaveLength(0);
      const opening = await waitFor(
        () => screen.messages.slice(before).find((e) => e.type === 'HOST_SPEECH_TRIGGERED' && e.payload.kind === 'OPENING'),
        'a fresh opening',
      );
      expect(opening).toBeDefined();
      const fresh = await waitFor(() => screen.messages.slice(before).filter(isRecord).at(0), 'fresh record');
      expect(fresh.payload.agendaIndex).toBe(0);
    });

    it('skips the spoken closing when silent, and only the screen may end a meeting', async () => {
      app = await createTestApp({ modules: [createMeetingModule()] });
      const screen = await connect('screen');
      const phone = await connect(testScenario.roles[0]!.id);
      say('Hello.');
      await waitFor(() => (screen.messages.some(isRecord) ? true : undefined), 'first record');

      phone.ws.send(JSON.stringify({ type: 'END_MEETING' }));
      await waitFor(
        () => phone.messages.find((e) => e.type === 'COMMAND_REJECTED'),
        'a rejection for the phone',
      );

      screen.ws.send(JSON.stringify({ type: 'END_MEETING', silent: true }));
      await settle(300);
      expect(screen.messages.some((e) => e.type === 'HOST_SPEECH_TRIGGERED' && e.payload.kind === 'CLOSING')).toBe(false);
    });

    it('ignores END_MEETING when no meeting is running', async () => {
      app = await createTestApp({ modules: [createMeetingModule()] });
      const screen = await connect('screen');
      screen.ws.send(JSON.stringify({ type: 'END_MEETING' }));
      await settle(300);
      expect(screen.messages.filter((e) => e.type === 'COMMAND_REJECTED' || e.type === 'HOST_SPEECH_TRIGGERED')).toHaveLength(0);
    });
  });
});

describe('openingLine', () => {
  it('orients a newcomer: organisation, situation, who is in the room, agenda and first item', () => {
    const scenario = {
      ...testScenario,
      situation: 'The team is checking that the product is ready to launch',
    };
    const line = openingLine(scenario);
    expect(line).toContain(`Welcome to ${scenario.meetingTitle} at ${scenario.organisation}.`);
    expect(line).toContain('The team is checking that the product is ready to launch.');
    expect(line).toContain('In the room: ');
    for (const attendee of scenario.attendees) expect(line).toContain(attendee.name);
    expect(line).toContain(`We have ${scenario.agenda.length} items today:`);
    expect(line).toContain(`Let's start with ${scenario.agenda[0]!.title}, ${scenario.agenda[0]!.minutes} minutes.`);
  });

  it('names the visitor and their role instead of the seat they took', () => {
    const seat = testScenario.attendees[0]!;
    const line = openingLine(testScenario, { name: 'Priya', seat: seat.name });
    expect(line).toContain('Priya, you are joining as ');
    expect(line).toMatch(new RegExp(`In the room: [^.]*Priya, `));
    expect(line).not.toContain(`${seat.name}, `);
    for (const other of testScenario.attendees.slice(1)) expect(line).toContain(other.name);
  });

  it('ignores a seat that is not in the scenario', () => {
    expect(openingLine(testScenario, { name: 'Priya', seat: 'Nobody' })).not.toContain('Priya');
  });

  it('still works without a situation', () => {
    const { situation: _situation, ...scenario } = { ...testScenario, situation: undefined };
    expect(openingLine(scenario)).toMatch(/^Welcome to .+ at .+\. In the room: /);
  });
});
