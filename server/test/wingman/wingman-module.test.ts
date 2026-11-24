import { describe, expect, it, vi } from 'vitest';
import {
  defaultMeetingSetup,
  type Fact,
  type KakiCommand,
  type KakiEvent,
  type Role,
  type Scenario,
  type SearchCompanyData,
  type Task,
} from '@kaki/shared';
import type { ClientAudience } from '../../src/core/audience';
import { roleAudience } from '../../src/core/audience';
import type { Hub } from '../../src/core/hub';
import type { TaskStore } from '../../src/meeting/tasks';
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

function meetingDetails(holders: Array<{ name: string; seat: Role; displayName?: string }>): SavedMeetingDetails {
  return {
    meetingId: 'meeting-1',
    phase: 'running',
    draft: defaultMeetingSetup(scenario),
    draftTouched: false,
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
      ),
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
