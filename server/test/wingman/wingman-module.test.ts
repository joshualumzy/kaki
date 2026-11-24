import { describe, expect, it, vi } from 'vitest';
import {
  defaultMeetingSetup,
  type Fact,
  type KakiCommand,
  type KakiEvent,
  type MeetingPace,
  type MeetingSetup,
  type Role,
  type Scenario,
  type SearchCompanyData,
  type Task,
} from '@kaki/shared';
import type { ClientAudience } from '../../src/core/audience';
import { roleAudience } from '../../src/core/audience';
import type { Hub } from '../../src/core/hub';
import type { TaskStore } from '../../src/meeting/tasks';
import type { MeetingSession } from '../../src/meeting/session';
import type { SavedMeetingDetails } from '../../src/persist/state';
import { createFakeLlm } from '../../src/services/llm';
import { createWingmanModules } from '../../src/wingman';
import { createWingmanModule } from '../../src/wingman/module';
import { waitFor } from '../helpers';

const scenario: Scenario = {
  id: 'test-wingman',
  organisation: 'Test Workspace',
  meetingTitle: 'Weekly chat',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', displayName: 'Ada' },
    { name: 'Bao', role: 'cashier', displayName: 'Bao' },
  ],
  agenda: [{ title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' }],
};

const factA: Fact = {
  text: 'The delivery window is 10:00 to 16:00.',
  source: 'Wiki: Delivery',
  date: '2026-11-01',
};
const factB: Fact = {
  text: 'The delivery window is 09:00 to 15:00.',
  source: 'Mattermost: #floor',
  date: '2026-11-20',
};

type CommandEffect = { commit(): void | Promise<void>; cancel?(): void };
type CommandHandler = (
  command: KakiCommand,
  sender: ClientAudience,
) => void | CommandEffect | Promise<void | CommandEffect>;

interface FakeHub {
  hub: Hub;
  published: KakiEvent[];
  retainKeys: (string | undefined)[];
  emit: (event: KakiEvent) => void;
  runCommand: (command: KakiCommand, sender: ClientAudience) => Promise<void>;
}

function fakeHub(): FakeHub {
  const handlers = new Set<(event: KakiEvent) => void>();
  const commandHandlers: CommandHandler[] = [];
  const published: KakiEvent[] = [];
  const retainKeys: (string | undefined)[] = [];
  const hub: Hub = {
    publish(event, options) {
      published.push(event);
      retainKeys.push(options?.retainKey);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onCommand(handler) {
      commandHandlers.push(handler as CommandHandler);
    },
    clearRetained() {},
    close() {
      handlers.clear();
    },
  };
  return {
    hub,
    published,
    retainKeys,
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
    async runCommand(command, sender) {
      for (const handler of commandHandlers) {
        const effect = await handler(command, sender);
        if (effect !== undefined && typeof effect === 'object') await effect.commit();
      }
    },
  };
}

function meetingDetails(
  holders: Array<{ name: string; seat: Role; displayName?: string }>,
  sealed?: MeetingSetup,
): SavedMeetingDetails {
  return {
    meetingId: 'meeting-1',
    phase: 'running',
    draft: defaultMeetingSetup(scenario),
    draftTouched: false,
    ...(sealed === undefined ? {} : { sealed }),
    holders: holders.map((holder) => ({ ...holder })),
    meetingCode: 'AB12CD',
  };
}

function transcriptLine(text: string, options: { speaker?: string; role?: Role; timestamp?: string } = {}): KakiEvent {
  return {
    type: 'TRANSCRIPT_CHUNK',
    audience: { kind: 'all' },
    payload: {
      speaker: options.speaker ?? 'Ada',
      text,
      timestamp: options.timestamp ?? '2026-11-22T10:00:00.000Z',
      ...(options.role === undefined ? {} : { speakerRole: options.role }),
    },
  };
}

function recordUpdate(): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: { agendaIndex: 0, openQuestions: [], elapsedSeconds: 5, speakerTalkSeconds: {} },
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Send the rota',
    context: '',
    suggestedAssignee: 'chef',
    status: 'SUGGESTED',
    updatedAt: '2026-11-22T10:00:00.000Z',
    ...overrides,
  };
}

function start(
  options: {
    hub: FakeHub;
    llm?: ReturnType<typeof createFakeLlm>;
    search?: SearchCompanyData;
    holders?: Array<{ name: string; seat: Role; displayName?: string }>;
    tasks?: Task[];
    now?: () => number;
    recordRateLimitMs?: number;
    meetingKind?: 'real' | 'practice';
    seatIsGuest?: (role: Role) => boolean | undefined;
    scenario?: Scenario;
    sealed?: MeetingSetup;
    offTheRecord?: () => boolean;
  },
): () => void {
  const tasks = options.tasks ?? [];
  const module = createWingmanModule({
    env: {},
    ...(options.llm === undefined ? {} : { llm: options.llm }),
    ...(options.search === undefined ? {} : { search: options.search }),
    askedCheckDelayMs: 0,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.recordRateLimitMs === undefined ? {} : { recordRateLimitMs: options.recordRateLimitMs }),
  });
  const taskStore: TaskStore = { list: () => tasks } as TaskStore;
  const stop = module.start({
    meetingId: () => 'meeting-1',
    workspaceId: () => 'workspace-1',
    hub: options.hub.hub,
    tasks: taskStore,
    activeScenario: () => options.scenario ?? scenario,
    meetingDetails: () =>
      meetingDetails(
        options.holders ?? [
          { name: 'Ada', seat: 'chef' },
          { name: 'Bao', seat: 'cashier' },
        ],
        options.sealed,
      ),
    ...(options.sealed === undefined && options.offTheRecord === undefined
      ? {}
      : {
          session: {
            sealed: () => options.sealed,
            offTheRecordSince: () => (options.offTheRecord?.() === true ? '2026-11-22T10:00:00.000Z' : undefined),
          } as unknown as MeetingSession,
        }),
    ...(options.meetingKind === undefined ? {} : { meetingKind: () => options.meetingKind }),
    ...(options.seatIsGuest === undefined ? {} : { seatIsGuest: options.seatIsGuest }),
  });
  if (typeof stop !== 'function') throw new Error('Expected a cleanup function');
  return stop;
}

function wingmanNotes(events: readonly KakiEvent[]): Array<Extract<KakiEvent, { type: 'WINGMAN_NOTE' }>> {
  return events.filter(
    (event): event is Extract<KakiEvent, { type: 'WINGMAN_NOTE' }> => event.type === 'WINGMAN_NOTE',
  );
}

describe('wingman module', () => {
  it('registers the same one module for real and practice meetings', () => {
    expect(createWingmanModules().map((module) => module.name)).toEqual(['wingman']);
  });

  it('answers a question from this meeting with the transcript line time as its source', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm((messages) => {
      expect(messages[0]?.content).toContain('[KAKI_WINGMAN_ASK]');
      return JSON.stringify({
        parts: [{ text: 'You missed the prep decision.', evidence: 'We agreed to prep early.', taskId: null }],
      });
    });
    const stop = start({ hub: fake, llm, search: async () => [] });
    try {
      fake.emit(transcriptLine('We agreed to prep early.'));

      await fake.runCommand({ type: 'ASK_WINGMAN', question: 'What did I miss?' }, roleAudience('chef'));

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(note?.payload).toMatchObject({
        kind: 'answer',
        urgency: 'quiet',
        text: 'You missed the prep decision.',
        questionText: 'What did I miss?',
        questionFrom: 'you',
      });
      expect(Number.isFinite(Date.parse(note?.payload.at ?? ''))).toBe(true);
      expect(note?.audience).toEqual({ kind: 'role', role: 'chef' });
      expect(note?.payload.sources?.[0]).toContain('Ada');
      expect(note?.payload.sources?.[0]).toContain('2026-11-22T10:00:00.000Z');
      expect(note?.payload.facts).toBeUndefined();
    } finally {
      stop();
    }
  });

  it('answers from the meeting only when the workspace has no qualifying record', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({
        parts: [{ text: 'You missed the prep decision.', evidence: 'We agreed to prep early.', taskId: null }],
      }),
    );
    const stop = start({ hub: fake, llm, search: async () => [] });
    try {
      fake.emit(transcriptLine('We agreed to prep early.'));
      await fake.runCommand({ type: 'ASK_WINGMAN', question: 'What is for lunch?' }, roleAudience('chef'));

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(note?.payload.text).toBe('You missed the prep decision.');
      expect(note?.payload.facts).toBeUndefined();
      expect(note?.payload.sources?.every((source) => source.includes('Ada'))).toBe(true);
    } finally {
      stop();
    }
  });

  it('answers a guest in a real meeting from the meeting only, never the workspace', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({
        parts: [{ text: 'You missed the prep decision.', evidence: 'We agreed to prep early.', taskId: null }],
      }),
    );
    const search = vi.fn<SearchCompanyData>(async () => [factA]);
    const stop = start({
      hub: fake,
      llm,
      search,
      meetingKind: 'real',
      seatIsGuest: (role) => role === 'chef',
    });
    try {
      fake.emit(transcriptLine('We agreed to prep early.'));
      await fake.runCommand({ type: 'ASK_WINGMAN', question: 'What did I miss?' }, roleAudience('chef'));

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(note?.payload.text).toBe('You missed the prep decision.');
      expect(note?.payload.facts).toBeUndefined();
      expect(note?.payload.sources?.some((source) => source.includes('Wiki: Delivery'))).not.toBe(true);
      expect(search).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('uses the workspace for a member in a real meeting', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() => JSON.stringify({ parts: [] }));
    const search = vi.fn<SearchCompanyData>(async () => [factA]);
    const stop = start({
      hub: fake,
      llm,
      search,
      meetingKind: 'real',
      seatIsGuest: () => false,
    });
    try {
      fake.emit(transcriptLine('What is the delivery window?'));
      await fake.runCommand(
        { type: 'ASK_WINGMAN', question: 'What is the delivery window?' },
        roleAudience('chef'),
      );

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(search).toHaveBeenCalledWith('What is the delivery window?', 'chef');
      expect(note?.payload.facts).toEqual([factA]);
      expect(note?.payload.sources).toEqual(['Wiki: Delivery (2026-11-01)']);
    } finally {
      stop();
    }
  });

  it('lets the host ask from a real meeting screen as their own facilitator seat', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({
        parts: [{ text: 'You missed the prep decision.', evidence: 'We agreed to prep early.', taskId: null }],
      }),
    );
    const hostScenario: Scenario = {
      ...scenario,
      roles: scenario.roles.map((role) => (role.id === 'chef' ? { ...role, facilitator: true } : role)),
    };
    const stop = start({
      hub: fake,
      llm,
      search: async () => [],
      meetingKind: 'real',
      holders: [{ name: 'Ada', seat: 'chef' }],
      scenario: hostScenario,
    });
    try {
      fake.emit(transcriptLine('We agreed to prep early.'));
      await fake.runCommand({ type: 'ASK_WINGMAN', question: 'What did I miss?' }, { kind: 'screen' });

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(note?.audience).toEqual({ kind: 'role', role: 'chef' });
      expect(note?.payload.questionText).toBe('What did I miss?');
    } finally {
      stop();
    }
  });

  it('keeps the practice meeting on its sample workspace', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() => JSON.stringify({ parts: [] }));
    const search = vi.fn<SearchCompanyData>(async () => [factA]);
    const stop = start({
      hub: fake,
      llm,
      search,
      meetingKind: 'practice',
      seatIsGuest: () => true,
    });
    try {
      fake.emit(transcriptLine('What is the delivery window?'));
      await fake.runCommand(
        { type: 'ASK_WINGMAN', question: 'What is the delivery window?' },
        roleAudience('chef'),
      );

      expect(search).toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('never gives a guest a record note from the workspace', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({ verdict: 'answers', snippet: factA.text, source: factA.source }),
    );
    const search = vi.fn<SearchCompanyData>(async () => [factA]);
    const stop = start({
      hub: fake,
      llm,
      search,
      meetingKind: 'real',
      seatIsGuest: () => true,
    });
    try {
      fake.emit(transcriptLine('What is the delivery window?', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(recordUpdate());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(wingmanNotes(fake.published).filter((event) => event.payload.kind === 'record')).toHaveLength(0);
      expect(search).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('treats an unknown identity as a guest and says so once', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() => JSON.stringify({ parts: [] }));
    const search = vi.fn<SearchCompanyData>(async () => [factA]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stop = start({
      hub: fake,
      llm,
      search,
      meetingKind: 'real',
      seatIsGuest: () => undefined,
    });
    try {
      fake.emit(transcriptLine('What is the delivery window?'));
      await fake.runCommand(
        { type: 'ASK_WINGMAN', question: 'What is the delivery window?' },
        roleAudience('chef'),
      );
      await fake.runCommand(
        { type: 'ASK_WINGMAN', question: 'And the refund window?' },
        roleAudience('cashier'),
      );

      expect(search).not.toHaveBeenCalled();
      expect(warn.mock.calls.filter((call) => String(call[0]).includes('treated as a guest'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      stop();
    }
  });

  it('says nothing is on that when the meeting and workspace are both empty', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() => JSON.stringify({ parts: [] }));
    const stop = start({ hub: fake, llm, search: async () => [] });
    try {
      fake.emit(transcriptLine('Just small talk.'));
      await fake.runCommand({ type: 'ASK_WINGMAN', question: 'What is our refund policy?' }, roleAudience('chef'));

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(note?.payload.text).toBe('Nothing on that in this meeting or your workspace.');
      expect(note?.payload.facts).toBeUndefined();
    } finally {
      stop();
    }
  });

  it('tells the person when the workspace search fails, never silently', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() => JSON.stringify({ parts: [] }));
    const stop = start({
      hub: fake,
      llm,
      search: async () => {
        throw new Error('search down');
      },
    });
    try {
      fake.emit(transcriptLine('Just small talk.'));
      await fake.runCommand({ type: 'ASK_WINGMAN', question: 'What is our refund policy?' }, roleAudience('chef'));

      const note = wingmanNotes(fake.published).find((event) => event.payload.kind === 'answer');
      expect(note?.payload.text).toBe("Couldn't search your workspace just now.");
    } finally {
      stop();
    }
  });

  it('notes a given to-do once per task and assignee', async () => {
    const fake = fakeHub();
    const stop = start({ hub: fake });
    try {
      const given = task({});
      fake.emit({ type: 'TASK_UPDATED', audience: { kind: 'role', role: 'chef' }, payload: { task: given } });
      fake.emit({ type: 'TASK_UPDATED', audience: { kind: 'role', role: 'chef' }, payload: { task: given } });

      const notes = wingmanNotes(fake.published).filter((event) => event.payload.kind === 'given');
      expect(notes).toHaveLength(1);
      expect(notes[0]?.audience).toEqual({ kind: 'role', role: 'chef' });
      expect(notes[0]?.payload.text).toBe(
        'You were given: Send the rota. Accept or change it on the card.',
      );
    } finally {
      stop();
    }
  });

  it('pops a direct question to the person, with workspace facts and sources', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({
        direct: true,
        question: 'When is the delivery?',
        evidence: 'Bao, when is the delivery?',
      }),
    );
    const search: SearchCompanyData = async () => [factA];
    const stop = start({ hub: fake, llm, search });
    try {
      fake.emit(transcriptLine('Bao, when is the delivery?', { speaker: 'Bao', role: 'cashier' }));

      const note = await waitFor(
        () =>
          wingmanNotes(fake.published).find((event) => event.payload.kind === 'asked_you'),
        'the direct-question note',
      );
      expect(note.payload).toMatchObject({
        kind: 'asked_you',
        urgency: 'act_now',
        title: 'Bao asked you',
        text: 'When is the delivery?',
        questionText: 'When is the delivery?',
      });
      expect(note.payload.facts).toEqual([factA]);
      expect(note.payload.sources).toEqual(['Wiki: Delivery (2026-11-01)']);
      expect(note.payload.questionFrom).toBe('person');
      expect(note.payload.askedBy).toBe('Bao');
      expect(Number.isFinite(Date.parse(note.payload.at ?? ''))).toBe(true);
      expect(note.audience).toEqual({ kind: 'role', role: 'chef' });
    } finally {
      stop();
    }
  });

  it('stays silent for a third-person mention, a room question, and an answered question', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({ direct: false, question: '', evidence: '' }),
    );
    const stop = start({ hub: fake, llm, search: async () => [factA] });
    try {
      fake.emit(transcriptLine('Bao said last week that it was handled.', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(transcriptLine('Does anyone know the server password?', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(transcriptLine('Bao asked me earlier and I answered.', { speaker: 'Bao', role: 'cashier' }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(wingmanNotes(fake.published).filter((event) => event.payload.kind === 'asked_you')).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('never pops the same direct question twice, even after it is dismissed', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({
        direct: true,
        question: 'When is the delivery?',
        evidence: 'Bao, when is the delivery?',
      }),
    );
    const stop = start({ hub: fake, llm, search: async () => [] });
    try {
      fake.emit(transcriptLine('Bao, when is the delivery?', { speaker: 'Bao', role: 'cashier' }));
      const note = await waitFor(
        () => wingmanNotes(fake.published).find((event) => event.payload.kind === 'asked_you'),
        'the first direct-question note',
      );
      await fake.runCommand(
        { type: 'DISMISS_WINGMAN_NOTE', id: note.payload.id },
        roleAudience('chef'),
      );
      const cleared = wingmanNotes(fake.published).filter(
        (event) => event.payload.id === note.payload.id && event.payload.clears === true,
      );
      expect(cleared).toHaveLength(1);

      fake.emit(transcriptLine('Bao, when is the delivery?', { speaker: 'Bao', role: 'cashier' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      const notes = wingmanNotes(fake.published).filter(
        (event) => event.payload.kind === 'asked_you' && event.payload.clears !== true,
      );
      expect(notes).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('clears an act-now note when the person speaks next', async () => {
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({
        direct: true,
        question: 'When is the delivery?',
        evidence: 'Bao, when is the delivery?',
      }),
    );
    const stop = start({ hub: fake, llm, search: async () => [] });
    try {
      fake.emit(transcriptLine('Bao, when is the delivery?', { speaker: 'Bao', role: 'cashier' }));
      const note = await waitFor(
        () => wingmanNotes(fake.published).find((event) => event.payload.kind === 'asked_you'),
        'the direct-question note',
      );

      fake.emit(transcriptLine('It is at ten.', { speaker: 'Ada', role: 'chef' }));
      const cleared = wingmanNotes(fake.published).find(
        (event) => event.payload.id === note.payload.id && event.payload.clears === true,
      );
      expect(cleared?.audience).toEqual({ kind: 'role', role: 'chef' });
      // A clear keeps the note's original publication time.
      expect(cleared?.payload.at).toBe(note.payload.at);
    } finally {
      stop();
    }
  });

  it('stays silent on a record by default, fires once on answers or contradicts, and rate-limits', async () => {
    let clock = 0;
    let recordFact = factA;
    const fake = fakeHub();
    const llm = createFakeLlm((messages) => {
      expect(messages[0]?.content).toContain('[KAKI_WINGMAN_RECORD]');
      return JSON.stringify({ verdict: 'answers', snippet: recordFact.text, source: recordFact.source });
    });
    const search: SearchCompanyData = async () => [recordFact];
    const stop = start({
      hub: fake,
      llm,
      search,
      holders: [{ name: 'Ada', seat: 'chef' }],
      now: () => clock,
      recordRateLimitMs: 90_000,
    });
    try {
      fake.emit(transcriptLine('What is the delivery window?', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(recordUpdate());
      const first = await waitFor(
        () => wingmanNotes(fake.published).find((event) => event.payload.kind === 'record'),
        'the first record note',
      );
      expect(first.payload.facts).toEqual([factA]);
      expect(first.payload.sources).toEqual(['Wiki: Delivery (2026-11-01)']);

      // Inside the rate limit: no check, no note.
      clock = 1_000;
      recordFact = factB;
      fake.emit(transcriptLine('So the window might change.', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(recordUpdate());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wingmanNotes(fake.published).filter((event) => event.payload.kind === 'record')).toHaveLength(1);

      // After the window, a different record may fire.
      clock = 92_000;
      fake.emit(transcriptLine('The window changed, right?', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(recordUpdate());
      await waitFor(
        () => wingmanNotes(fake.published).filter((event) => event.payload.kind === 'record').length === 2,
        'the second record note',
      );

      // The same record is never sent twice to the same person.
      clock = 200_000;
      recordFact = factA;
      fake.emit(transcriptLine('So the window might change again.', { speaker: 'Bao', role: 'cashier' }));
      fake.emit(recordUpdate());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wingmanNotes(fake.published).filter((event) => event.payload.kind === 'record')).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it('does not judge a record from the AI host agenda cue', async () => {
    const hostScenario: Scenario = {
      ...scenario,
      roles: [...scenario.roles, { id: 'host', label: 'Host', facilitator: true }],
      attendees: [...scenario.attendees, { name: 'Sam', role: 'host', displayName: 'Sam' }],
      npcs: [{ attendee: 'Sam', role: 'host' }],
    } as Scenario;
    const fake = fakeHub();
    const llm = createFakeLlm(() =>
      JSON.stringify({ verdict: 'answers', snippet: factA.text, source: factA.source }),
    );
    const module = createWingmanModule({ env: {}, llm, search: async () => [factA], askedCheckDelayMs: 0 });
    const stop = module.start({
      meetingId: () => 'meeting-1',
      workspaceId: () => 'workspace-1',
      hub: fake.hub,
      tasks: { list: () => [] } as unknown as TaskStore,
      activeScenario: () => hostScenario,
      meetingDetails: () => meetingDetails([{ name: 'Ada', seat: 'chef' }]),
    });
    if (typeof stop !== 'function') throw new Error('Expected a cleanup function');
    try {
      fake.emit(transcriptLine('Next item: staffing.', { speaker: 'Sam', role: 'host' }));
      fake.emit(recordUpdate());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(wingmanNotes(fake.published).filter((event) => event.payload.kind === 'record')).toHaveLength(0);
    } finally {
      stop();
    }
  });
});

const cuePace: MeetingPace = { ownerQuietBelow: 30, quietCheckAfter: 120, comingUpBefore: 60 };

const cueScenario: Scenario = {
  id: 'test-wingman-cues',
  organisation: 'Test Workspace',
  meetingTitle: 'Weekly planning',
  roles: [
    { id: 'host', label: 'Host', facilitator: true },
    { id: 'raj', label: 'Raj' },
    { id: 'mei', label: 'Mei' },
  ],
  attendees: [
    { name: 'Ada', role: 'host', displayName: 'Ada' },
    { name: 'Raj', role: 'raj', displayName: 'Raj' },
    { name: 'Mei', role: 'mei', displayName: 'Mei' },
  ],
  agenda: [
    { title: 'Budget', minutes: 10, canWait: false, deadline: 'today', ownerRole: 'raj' },
    { title: 'Hiring', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'mei' },
  ],
};

const cueHolders: Array<{ name: string; seat: Role }> = [
  { name: 'Ada', seat: 'host' },
  { name: 'Raj', seat: 'raj' },
  { name: 'Mei', seat: 'mei' },
];

function sealedCue(options: { pace?: MeetingPace; scenario?: Scenario } = {}): MeetingSetup {
  return {
    ...defaultMeetingSetup(options.scenario ?? cueScenario),
    pace: { ...(options.pace ?? cuePace) },
  };
}

type NoteEvent = Extract<KakiEvent, { type: 'WINGMAN_NOTE' }>;

function cueRecord(
  payload: Partial<{
    agendaIndex: number;
    openQuestions: Array<{ id: string; text: string; agendaIndex: number }>;
    elapsedSeconds: number;
    speakerTalkSeconds: Partial<Record<Role, number>>;
    paused: boolean;
    ended: boolean;
  }>,
): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'screen' },
    payload: {
      agendaIndex: 0,
      openQuestions: [],
      elapsedSeconds: 0,
      speakerTalkSeconds: {},
      ...payload,
    },
  };
}

function notesOfKind(events: readonly KakiEvent[], kind: 'lead' | 'nudge'): NoteEvent[] {
  return events.filter(
    (event): event is NoteEvent => event.type === 'WINGMAN_NOTE' && event.payload.kind === kind,
  );
}

function activeNotes(events: readonly KakiEvent[], kind: 'lead' | 'nudge'): NoteEvent[] {
  // A note with the same id replaces the earlier one, and a clear retracts it.
  const byId = new Map<string, NoteEvent>();
  for (const event of notesOfKind(events, kind)) byId.set(event.payload.id, event);
  return [...byId.values()].filter((event) => event.payload.clears !== true);
}

const noPointReply = JSON.stringify({ suggestion: '', basis: 'none', evidence: '', source: '' });

function catchupLlm(reply: string): ReturnType<typeof createFakeLlm> {
  return createFakeLlm((messages) =>
    messages[0]?.content.includes('[KAKI_WINGMAN_CATCHUP]') ? reply : noPointReply,
  );
}

describe('wingman real-meeting pace cues', () => {
  it('shows the owner who has not spoken, updates that line, and clears it when everyone has spoken', () => {
    const fake = fakeHub();
    const stop = start({
      hub: fake,
      llm: catchupLlm(noPointReply),
      search: async () => [],
      holders: cueHolders,
      meetingKind: 'real',
      scenario: cueScenario,
      sealed: sealedCue(),
    });
    try {
      fake.emit(cueRecord({ elapsedSeconds: 119, speakerTalkSeconds: { host: 40 } }));
      expect(activeNotes(fake.published, 'lead')).toEqual([]);

      fake.emit(cueRecord({ elapsedSeconds: 120, speakerTalkSeconds: { host: 40 } }));
      let leads = activeNotes(fake.published, 'lead');
      expect(leads).toHaveLength(1);
      expect(leads[0]?.audience).toEqual({ kind: 'role', role: 'host' });
      expect(leads[0]?.payload.text).toBe('Not heard from yet: Raj, Mei');

      // As Raj starts talking the same line shrinks, without a second note id.
      fake.emit(cueRecord({ elapsedSeconds: 130, speakerTalkSeconds: { host: 40, raj: 12 } }));
      leads = activeNotes(fake.published, 'lead');
      expect(leads).toHaveLength(1);
      expect(leads[0]?.payload.id).toBe('lead:0');
      expect(leads[0]?.payload.text).toBe('Not heard from yet: Mei');

      // Once everyone has spoken the line goes away.
      fake.emit(cueRecord({ elapsedSeconds: 140, speakerTalkSeconds: { host: 40, raj: 12, mei: 8 } }));
      expect(activeNotes(fake.published, 'lead')).toEqual([]);
      expect(
        notesOfKind(fake.published, 'lead').filter((event) => event.payload.clears === true),
      ).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('sends one catch-up with the item, open question and a meeting-grounded point, then removes it when they speak', async () => {
    const fake = fakeHub();
    const stop = start({
      hub: fake,
      llm: catchupLlm(
        JSON.stringify({
          suggestion: 'Ask whether the launch budget still covers the new plan.',
          basis: 'meeting',
          evidence: 'We need the budget figure before we decide.',
          source: '',
        }),
      ),
      search: async () => [],
      holders: cueHolders,
      meetingKind: 'real',
      scenario: cueScenario,
      sealed: sealedCue(),
    });
    try {
      fake.emit(transcriptLine('We need the budget figure before we decide.', { speaker: 'Ada', role: 'host' }));
      fake.emit(cueRecord({ elapsedSeconds: 119, speakerTalkSeconds: { host: 40, mei: 6 } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(activeNotes(fake.published, 'nudge')).toEqual([]);

      fake.emit(
        cueRecord({
          elapsedSeconds: 121,
          speakerTalkSeconds: { host: 40, mei: 6 },
          openQuestions: [{ id: 'q-1', text: 'Do we still have launch budget?', agendaIndex: 0 }],
        }),
      );
      const note = await waitFor(
        () => wingmanNotes(fake.published).find((event) => event.payload.id === 'catchup:raj:0'),
        'the catch-up note',
      );
      expect(note.audience).toEqual({ kind: 'role', role: 'raj' });
      expect(note.payload.kind).toBe('nudge');
      expect(note.payload.text).toContain('Now: "Budget".');
      expect(note.payload.text).toContain('Open question: Do we still have launch budget?');
      expect(note.payload.text).toContain(
        'One point you could add: Ask whether the launch budget still covers the new plan.',
      );
      expect(note.payload.sources).toEqual(['Ada · 2026-11-22T10:00:00.000Z']);
      expect(note.payload.facts).toBeUndefined();
      expect(note.payload.text).not.toMatch(/expected|haven't spoken|have not spoken/i);

      // One per item, however many records follow.
      fake.emit(cueRecord({ elapsedSeconds: 130, speakerTalkSeconds: { host: 40, mei: 6 } }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        wingmanNotes(fake.published).filter((event) => event.payload.id === 'catchup:raj:0'),
      ).toHaveLength(1);

      // Speaking removes it.
      fake.emit(transcriptLine('I have the figure here.', { speaker: 'Raj', role: 'raj' }));
      expect(
        wingmanNotes(fake.published).some(
          (event) => event.payload.id === 'catchup:raj:0' && event.payload.clears === true,
        ),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it('adds no suggestion when the model finds nothing worth adding', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const fake = fakeHub();
      const stop = start({
        hub: fake,
        llm: catchupLlm(noPointReply),
        search: async () => [factA],
        holders: cueHolders,
        meetingKind: 'real',
        scenario: cueScenario,
        sealed: sealedCue(),
      });
      try {
        fake.emit(cueRecord({ elapsedSeconds: 121, speakerTalkSeconds: { host: 40, mei: 6 } }));
        const note = await waitFor(
          () => wingmanNotes(fake.published).find((event) => event.payload.id === 'catchup:raj:0'),
          'the plain catch-up',
        );
        expect(note.payload.text).toBe('Now: "Budget".');
        expect(note.payload.text).not.toContain('One point you could add');
        expect(note.payload.facts).toBeUndefined();
        expect(note.payload.sources).toBeUndefined();
        expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('catch-up'));
      } finally {
        stop();
      }
    } finally {
      errors.mockRestore();
    }
  });

  it('adds one workspace point with its source for a member, never for a guest or with search off', async () => {
    for (const mode of ['member', 'guest', 'off'] as const) {
      const search = vi.fn<SearchCompanyData>(async () => [factA]);
      const fake = fakeHub();
      const stop = start({
        hub: fake,
        llm: catchupLlm(
          JSON.stringify({
            suggestion: 'Ask about the delivery window.',
            basis: 'workspace',
            evidence: factA.text,
            source: factA.source,
          }),
        ),
        ...(mode === 'off' ? {} : { search }),
        holders: cueHolders,
        meetingKind: 'real',
        seatIsGuest: (role) => mode === 'guest' && role === 'raj',
        scenario: cueScenario,
        sealed: sealedCue(),
      });
      try {
        fake.emit(cueRecord({ elapsedSeconds: 121, speakerTalkSeconds: { host: 40, mei: 6 } }));
        const note = await waitFor(
          () => wingmanNotes(fake.published).find((event) => event.payload.id === 'catchup:raj:0'),
          `the ${mode} catch-up`,
        );
        if (mode === 'member') {
          expect(search).toHaveBeenCalledWith('Budget', 'raj');
          expect(note.payload.facts).toEqual([{ ...factA, text: 'Ask about the delivery window.' }]);
          expect(note.payload.sources).toEqual(['Wiki: Delivery (2026-11-01)']);
          // A workspace point stays in its fact, ready to be withheld on a reconnect.
          expect(note.payload.text).not.toContain('Ask about the delivery window.');
        } else {
          expect(note.payload.facts).toBeUndefined();
          expect(note.payload.sources).toBeUndefined();
          expect(note.payload.text).toBe('Now: "Budget".');
          if (mode === 'guest') expect(search).not.toHaveBeenCalled();
        }
      } finally {
        stop();
      }
    }
  });

  it('sends the plain catch-up and logs loudly when there is no model or it fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const llm of [undefined, createFakeLlm(() => { throw new Error('model down'); })]) {
        const fake = fakeHub();
        const stop = start({
          hub: fake,
          ...(llm === undefined ? {} : { llm }),
          search: async () => [factA],
          holders: cueHolders,
          meetingKind: 'real',
          scenario: cueScenario,
          sealed: sealedCue(),
        });
        try {
          fake.emit(
            cueRecord({
              elapsedSeconds: 121,
              speakerTalkSeconds: { host: 40, mei: 6 },
              openQuestions: [{ id: 'q-1', text: 'Do we still have launch budget?', agendaIndex: 0 }],
            }),
          );
          const note = await waitFor(
            () => wingmanNotes(fake.published).find((event) => event.payload.id === 'catchup:raj:0'),
            'the plain catch-up',
          );
          expect(note.payload.text).toContain('Now: "Budget".');
          expect(note.payload.text).toContain('Open question: Do we still have launch budget?');
          expect(note.payload.text).not.toContain('One point you could add');
          expect(note.payload.facts).toBeUndefined();
          expect(errors).toHaveBeenCalledWith(
            expect.stringContaining('catch-up'),
            ...(llm === undefined ? [] : [expect.any(Error)]),
          );
        } finally {
          stop();
        }
      }
    } finally {
      errors.mockRestore();
    }
  });

  it('warns the next named owner once before the item ends and removes it when the meeting ends', async () => {
    const fake = fakeHub();
    const stop = start({
      hub: fake,
      llm: catchupLlm(noPointReply),
      search: async () => [],
      holders: cueHolders,
      meetingKind: 'real',
      scenario: cueScenario,
      sealed: sealedCue(),
    });
    try {
      const upcoming = (): NoteEvent[] =>
        activeNotes(fake.published, 'nudge').filter(
          (event) => event.payload.title === 'Your next item',
        );

      fake.emit(cueRecord({ elapsedSeconds: 539, speakerTalkSeconds: { host: 40, raj: 8, mei: 8 } }));
      expect(upcoming()).toEqual([]);

      fake.emit(cueRecord({ elapsedSeconds: 540, speakerTalkSeconds: { host: 40, raj: 8, mei: 8 } }));
      const warnings = upcoming();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.audience).toEqual({ kind: 'role', role: 'mei' });
      expect(warnings[0]?.payload.text).toBe("Up next in about 1 min: Hiring, it's yours.");

      fake.emit(cueRecord({ elapsedSeconds: 550, speakerTalkSeconds: { host: 40, raj: 8, mei: 8 } }));
      expect(upcoming()).toHaveLength(1);

      fake.emit(cueRecord({ ended: true, elapsedSeconds: 551 }));
      expect(upcoming()).toEqual([]);
    } finally {
      stop();
    }
  });

  it('never warns the next owner when the item does not name exactly one present seat', () => {
    const cases: Array<{ name: string; holders: typeof cueHolders; scenario: Scenario }> = [
      {
        name: 'unassigned',
        holders: cueHolders,
        scenario: {
          ...cueScenario,
          agenda: [cueScenario.agenda[0]!, { ...cueScenario.agenda[1]!, ownerRole: 'everyone' }],
        },
      },
      {
        name: 'absent',
        holders: cueHolders.filter((holder) => holder.seat !== 'mei'),
        scenario: cueScenario,
      },
      {
        name: 'ambiguous',
        holders: [...cueHolders, { name: 'Mei', seat: 'mei' }],
        scenario: cueScenario,
      },
      {
        name: 'unregistered',
        holders: cueHolders,
        scenario: {
          ...cueScenario,
          roles: cueScenario.roles.filter((role) => role.id !== 'mei'),
        },
      },
    ];
    for (const state of cases) {
      const fake = fakeHub();
      const stop = start({
        hub: fake,
        llm: catchupLlm(noPointReply),
        search: async () => [],
        holders: state.holders,
        meetingKind: 'real',
        scenario: state.scenario,
        sealed: sealedCue({ scenario: state.scenario }),
      });
      try {
        fake.emit(cueRecord({ elapsedSeconds: 540, speakerTalkSeconds: { host: 40, raj: 8 } }));
        expect(
          activeNotes(fake.published, 'nudge').filter(
            (event) => event.payload.title === 'Your next item',
          ),
          state.name,
        ).toEqual([]);
      } finally {
        stop();
      }
    }
  });

  it('removes the lead, catch-up and up-next notes when the item changes, and catch-ups when the meeting ends', async () => {
    const fake = fakeHub();
    const stop = start({
      hub: fake,
      llm: catchupLlm(noPointReply),
      search: async () => [],
      holders: cueHolders,
      meetingKind: 'real',
      scenario: cueScenario,
      sealed: sealedCue(),
    });
    try {
      fake.emit(cueRecord({ elapsedSeconds: 540, speakerTalkSeconds: { host: 40, mei: 6 } }));
      const catchup = await waitFor(
        () => wingmanNotes(fake.published).find((event) => event.payload.id === 'catchup:raj:0'),
        'the catch-up',
      );
      const upNext = await waitFor(
        () =>
          wingmanNotes(fake.published).find(
            (event) => event.payload.title === 'Your next item' && event.payload.clears !== true,
          ),
        'the up-next note',
      );
      const lead = await waitFor(
        () => wingmanNotes(fake.published).find((event) => event.payload.kind === 'lead'),
        'the lead line',
      );
      expect(catchup.payload.clears).not.toBe(true);
      expect(lead.payload.clears).not.toBe(true);

      // The next item starts: the old item's notes all go.
      fake.emit(cueRecord({ agendaIndex: 1, elapsedSeconds: 0, speakerTalkSeconds: {} }));
      const cleared = wingmanNotes(fake.published)
        .filter((event) => event.payload.clears === true)
        .map((event) => event.payload.id);
      expect(cleared).toEqual(
        expect.arrayContaining([catchup.payload.id, upNext.payload.id, lead.payload.id]),
      );

      // A catch-up on the new item goes when the meeting ends.
      fake.emit(cueRecord({ agendaIndex: 1, elapsedSeconds: 121, speakerTalkSeconds: { host: 40, mei: 6 } }));
      const second = await waitFor(
        () =>
          wingmanNotes(fake.published).find(
            (event) => event.payload.id === 'catchup:raj:1' && event.payload.clears !== true,
          ),
        'the second catch-up',
      );
      fake.emit(cueRecord({ agendaIndex: 1, elapsedSeconds: 130, ended: true }));
      expect(
        wingmanNotes(fake.published).some(
          (event) => event.payload.id === second.payload.id && event.payload.clears === true,
        ),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it('does nothing in a practice meeting', () => {
    const fake = fakeHub();
    const stop = start({
      hub: fake,
      llm: catchupLlm(noPointReply),
      search: async () => [],
      holders: cueHolders,
      meetingKind: 'practice',
      scenario: cueScenario,
      sealed: sealedCue(),
    });
    try {
      fake.emit(cueRecord({ elapsedSeconds: 121, speakerTalkSeconds: { host: 40 } }));
      fake.emit(cueRecord({ elapsedSeconds: 540, speakerTalkSeconds: { host: 40 } }));
      expect(notesOfKind(fake.published, 'lead')).toEqual([]);
      expect(
        notesOfKind(fake.published, 'nudge').filter(
          (event) =>
            event.payload.title.startsWith('Catch-up') || event.payload.title === 'Your next item',
        ),
      ).toEqual([]);
    } finally {
      stop();
    }
  });
});
