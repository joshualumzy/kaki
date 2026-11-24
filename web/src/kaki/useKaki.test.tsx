/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { MEETING_ENDED_MESSAGE } from '@kaki/shared';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingScopeProvider } from './meetingScope';

const scenarioMock = vi.hoisted(() => {
  const original = {
    id: 'lifecycle-test',
    organisation: 'Test Kitchen',
    meetingTitle: 'Prep',
    roles: [
      { id: 'chef', label: 'Chef' },
      { id: 'operations_director', label: 'Producer' },
      { id: 'host', label: 'Host', facilitator: true },
    ],
    attendees: [{ name: 'Ada', role: 'chef', displayName: 'Ada (Chef)' }],
    agenda: [{ title: 'Prep', minutes: 5, canWait: false, deadline: 'before service', ownerRole: 'chef' }],
  };
  return { current: original, original };
});

vi.mock('./ScenarioContext', () => ({ useScenario: () => scenarioMock.current }));

interface FakeSocketInstance {
  emit(type: string, event?: unknown): void;
  readonly sent: string[];
  readonly url: string;
}


/** Render a meeting hook inside the one meeting every socket and fetch belongs to. */
function renderMeetingHook<T>(
  hook: () => T,
  options: { wrapper?: (props: { children: ReactNode }) => ReactNode } = {},
) {
  const Provided = options.wrapper;
  return renderHook(hook, {
    wrapper: ({ children }) => (
      <MeetingScopeProvider meetingId="mtg-1">
        {Provided === undefined ? children : <Provided>{children}</Provided>}
      </MeetingScopeProvider>
    ),
  });
}

const sockets = vi.hoisted(() => [] as FakeSocketInstance[]);

class FakeWebSocket {
  static OPEN = 1;

  static readonly instances = sockets;

  readyState = FakeWebSocket.OPEN;

  readonly sent: string[] = [];

  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(readonly url: string) {
    sockets.push(this);
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  send(data?: string): void {
    if (data !== undefined) this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }

  emit(type: string, event?: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }
}

function startEvent(meetingId = 'meeting-a'): { data: string } {
  return {
    data: JSON.stringify({
      type: 'MEETING_STARTED',
      audience: { kind: 'all' },
      payload: { meetingId, startedAt: '2026-11-19T09:00:00.000Z' },
    }),
  };
}

function resetEvent(meetingId = 'meeting-b'): { data: string } {
  return {
    data: JSON.stringify({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId } }),
  };
}

function recordEvent(agendaIndex: number): { data: string } {
  return {
    data: JSON.stringify({
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'screen' },
      payload: {
        agendaIndex,
        openQuestions: [],
        elapsedSeconds: 0,
        speakerTalkSeconds: {},
        notetakerStatus: 'ok',
        quietRoles: [],
      },
    }),
  };
}

function transcriptEvent(
  speaker: string,
  text: string,
  speakerRole?: 'chef' | 'operations_director' | 'host',
): { data: string } {
  return {
    data: JSON.stringify({
      type: 'TRANSCRIPT_CHUNK',
      audience: { kind: 'all' },
      payload: {
        speaker,
        text,
        timestamp: new Date().toISOString(),
        ...(speakerRole === undefined ? {} : { speakerRole }),
      },
    }),
  };
}

beforeEach(() => {
  sockets.splice(0);
  scenarioMock.current = scenarioMock.original;
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useKaki lifecycle state', () => {
  it('keeps an explicit started flag after a reset clears the event list', async () => {
    // Import after the WebSocket stub is in place and the hook's module graph is fresh.
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', startEvent()));
    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.events.some((event) => event.type === 'MEETING_STARTED')).toBe(true);
    expect(result.current.meetingId).toBe('meeting-a');

    act(() => socket.emit('message', resetEvent()));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(result.current.meetingId).toBe('meeting-b');
    // The reset clears the event list; the lifecycle flag is the state the browser can still read.
    expect(result.current.events).toEqual([]);
  });

  it('reads the authoritative lifecycle state when a lifecycle feed connects', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetingId: 'meeting-a', started: false }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'lifecycle' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/api/meetings/mtg-1/meeting/state');
  });

  it('discards a state answer from a socket that has been replaced', async () => {
    const answers: Array<(value: unknown) => void> = [];
    const fetchMock = vi.fn(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'lifecycle' }));
    const first = sockets[0]!;

    act(() => first.emit('open'));
    // The first socket closes before its answer arrives; the hook reconnects on its own.
    act(() => first.emit('close'));
    await waitFor(() => expect(sockets[1]).toBeDefined());
    const second = sockets[1]!;
    act(() => second.emit('open'));

    await act(async () => {
      answers[1]!({
        ok: true,
        status: 200,
        json: async () => ({ meetingId: 'meeting-new', started: false }),
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.started).toBe(false));

    await act(async () => {
      answers[0]!({
        ok: true,
        status: 200,
        json: async () => ({ meetingId: 'meeting-old', started: true }),
      });
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The closed socket's old answer must not reopen Start after the reset.
    expect(result.current.started).toBe(false);
  });

  it('reloads the scenario on a real start or reset, but not on a retained start replay', async () => {
    const { scenarioRevision } = await import('./scenarioRevision');
    const { useKaki } = await import('./useKaki');
    const before = scenarioRevision();
    const { result } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;

    act(() => first.emit('open'));
    act(() => first.emit('message', startEvent('meeting-start')));
    await waitFor(() => expect(result.current.started).toBe(true));
    expect(scenarioRevision()).toBeGreaterThan(before);
    const afterStart = scenarioRevision();

    // A reconnect replays the retained START; the browser already has this meeting's sealed plan.
    act(() => (first as unknown as { close(): void }).close());
    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const second = sockets[1]!;
    act(() => second.emit('open'));
    act(() => second.emit('message', startEvent('meeting-start')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scenarioRevision()).toBe(afterStart);

    act(() => second.emit('message', resetEvent('meeting-reset')));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(scenarioRevision()).toBeGreaterThan(afterStart);
  });

  it('does not tear down a live feed or its transcript when the meeting plan refreshes', async () => {
    const { useKaki } = await import('./useKaki');
    const { result, rerender } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;
    act(() => first.emit('open'));
    act(() => first.emit('message', transcriptEvent('Ada', 'The stock count is in.')));
    await waitFor(() => expect(result.current.events.some((event) => event.type === 'TRANSCRIPT_CHUNK')).toBe(true));

    scenarioMock.current = { ...scenarioMock.original, meetingTitle: 'Prep (sealed)' };
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sockets).toHaveLength(1);
    expect(result.current.events.some((event) => event.type === 'TRANSCRIPT_CHUNK')).toBe(true);
  });

  it('keeps the newest meeting record even after it leaves the event window', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    const record = {
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'screen' },
      payload: {
        agendaIndex: 2,
        openQuestions: [],
        elapsedSeconds: 0,
        speakerTalkSeconds: {},
        notetakerStatus: 'ok',
        quietRoles: [],
        paused: true,
      },
    };
    act(() => socket.emit('message', { data: JSON.stringify(record) }));
    await waitFor(() => expect(result.current.latestRecord?.payload.agendaIndex).toBe(2));

    act(() => {
      for (let index = 0; index < 60; index += 1) {
        socket.emit('message', {
          data: JSON.stringify({
            type: 'TRANSCRIPT_CHUNK',
            audience: { kind: 'screen' },
            payload: { speaker: 'Ada', text: `line ${index}`, timestamp: new Date().toISOString() },
          }),
        });
      }
    });

    expect(result.current.events).toHaveLength(50);
    expect(result.current.events.some((event) => event.type === 'MEETING_RECORD_UPDATED')).toBe(false);
    expect(result.current.latestRecord?.payload.agendaIndex).toBe(2);
    expect(result.current.latestRecord?.payload.paused).toBe(true);
  });

  it('does not replay a pause that could not be sent while the hub socket was down', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;
    act(() => first.emit('open'));
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => (first as unknown as { close(): void }).close());
    // The person presses Stop while the hub socket is reconnecting: it is refused, not queued.
    act(() => result.current.send({ type: 'SET_PAUSED', paused: true }));
    await waitFor(() => expect(result.current.rejection?.commandType).toBe('SET_PAUSED'));

    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const second = sockets[1]! as unknown as { emit(type: string): void; sent: string[] };
    act(() => second.emit('open'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // It must not arrive after a reconnect: no stale Stop outlives the socket it was made on.
    expect(second.sent).toEqual([]);
  });

  it('stops reconnecting and reports the ended meeting after a failed reconnect', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: MEETING_ENDED_MESSAGE, authEnabled: true, ended: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;

    act(() => first.emit('open'));
    act(() => first.emit('close', { code: 1006 }));
    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const failed = sockets[1]!;

    // The reconnect was refused before it opened: the phone must ask whether its meeting is gone.
    act(() => failed.emit('close', { code: 1006 }));
    await waitFor(() => expect(result.current.ended).toBe(MEETING_ENDED_MESSAGE));

    const count = sockets.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(sockets.length).toBe(count);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/me', undefined);
  });

  it('still ends the feed when the server words its ended answer differently', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'That code is no longer in use.', authEnabled: true, ended: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;

    act(() => first.emit('open'));
    act(() => first.emit('close', { code: 1006 }));
    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const failed = sockets[1]!;

    act(() => failed.emit('close', { code: 1006 }));
    await waitFor(() => expect(result.current.ended).toBe(MEETING_ENDED_MESSAGE));

    const count = sockets.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(sockets.length).toBe(count);
  });

});

describe('useKaki Wingman notes', () => {
  function noteMessage(id: string, text: string, clears = false): { data: string } {
    return {
      data: JSON.stringify({
        type: 'WINGMAN_NOTE',
        audience: { kind: 'role', role: 'chef' },
        payload: {
          id,
          kind: 'answer',
          urgency: 'quiet',
          title: 'Wingman',
          text,
          ...(clears ? { clears: true } : {}),
        },
      }),
    };
  }

  it("keeps this feed's own notes and removes one when the server clears it", async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'participant' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.')));
    await waitFor(() => expect(result.current.wingmanNotes).toHaveLength(1));
    expect(result.current.wingmanNotes[0]).toMatchObject({ id: 'answer:chef', text: 'A private answer.' });

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.', true)));
    await waitFor(() => expect(result.current.wingmanNotes).toHaveLength(0));
  });

  it('keeps a cleared note in history while the active list drops it', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'participant' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.')));
    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.', true)));

    await waitFor(() => expect(result.current.wingmanNotes).toHaveLength(0));
    expect(result.current.wingmanHistory).toHaveLength(1);
    expect(result.current.wingmanHistory[0]?.note).toMatchObject({ id: 'answer:chef', clears: true });
  });

  it('keeps history after more than fifty later events push the note out of the window', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'participant' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.')));
    await waitFor(() => expect(result.current.wingmanHistory).toHaveLength(1));

    act(() => {
      for (let index = 0; index < 55; index += 1) {
        socket.emit('message', transcriptEvent('Sam', `filler ${index}`));
      }
    });

    expect(result.current.events).toHaveLength(50);
    expect(result.current.wingmanHistory).toHaveLength(1);
    expect(result.current.wingmanHistory[0]?.note.text).toBe('A private answer.');
  });

  it('forgets the Wingman history when the meeting resets', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'participant' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.')));
    await waitFor(() => expect(result.current.wingmanHistory).toHaveLength(1));

    act(() => socket.emit('message', resetEvent('meeting-b')));
    await waitFor(() => expect(result.current.wingmanHistory).toHaveLength(0));
  });

  it('shows no private history on the shared screen', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.')));

    expect(result.current.wingmanNotes).toHaveLength(0);
    expect(result.current.wingmanHistory).toHaveLength(0);
  });

  it('sends ASK_WINGMAN to the server for this seat', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => {
      expect(result.current.askWingman('what did we decide?')).toBe(true);
    });
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'ASK_WINGMAN',
      question: 'what did we decide?',
    });
  });
});

describe('useKaki topic speech', () => {
  it('records a seat that spoke on the topic even after its record leaves the event window', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', recordEvent(2)));
    await waitFor(() => expect(result.current.latestRecord?.payload.agendaIndex).toBe(2));

    act(() => {
      for (let index = 0; index < 55; index += 1) {
        socket.emit('message', transcriptEvent('Sam', `filler ${index}`));
      }
    });
    act(() => socket.emit('message', transcriptEvent('Renamed Guest', 'The practical catch is the rush.', 'operations_director')));

    await waitFor(() => expect(result.current.speechByTopic.get(2)?.roles.has('operations_director')).toBe(true));
    expect(result.current.events.some((event) => event.type === 'MEETING_RECORD_UPDATED')).toBe(false);
    expect(result.current.speechByTopic.get(2)?.names.has('sam')).toBe(true);
  });

  it('does not record a colleague seat as the viewer', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', recordEvent(1)));
    act(() => socket.emit('message', transcriptEvent('Other Person', 'Stock is fine.', 'host')));

    await waitFor(() => expect(result.current.speechByTopic.get(1)?.roles.has('host')).toBe(true));
    expect(result.current.speechByTopic.get(1)?.roles.has('operations_director')).toBe(false);
  });

  it('forgets who spoke when the meeting resets', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderMeetingHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', recordEvent(1)));
    act(() => socket.emit('message', transcriptEvent('Ada', 'One decision.', 'chef')));
    await waitFor(() => expect(result.current.speechByTopic.size).toBeGreaterThan(0));

    act(() => socket.emit('message', resetEvent('meeting-b')));
    await waitFor(() => expect(result.current.speechByTopic.size).toBe(0));
  });
});

describe('one shared socket per feed on a page', () => {
  function taskEvent(id: string, title: string, audience: { kind: 'screen' } | { kind: 'role'; role: string }) {
    return {
      data: JSON.stringify({
        type: 'TASK_UPDATED',
        audience,
        payload: {
          task: {
            id,
            title,
            context: '',
            suggestedAssignee: 'chef',
            status: 'SUGGESTED',
            updatedAt: '2026-11-19T09:00:00.000Z',
          },
        },
      }),
    };
  }

  function socketFor(channel: string): FakeSocketInstance {
    const socket = sockets.find((candidate) => candidate.url.includes(channel));
    if (socket === undefined) throw new Error(`no socket for ${channel}`);
    return socket;
  }

  it('opens exactly one socket per distinct feed and shares it with every consumer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetingId: 'meeting-a', started: false }),
    })));
    const { useKaki } = await import('./useKaki');
    const { KakiConnectionProvider } = await import('./connection');

    const { result } = renderMeetingHook(
      () => ({
        lifecycle: useKaki({ kind: 'lifecycle' }),
        screenA: useKaki({ kind: 'screen' }),
        screenB: useKaki({ kind: 'screen' }),
        roleA: useKaki({ kind: 'role', role: 'chef' }),
        roleB: useKaki({ kind: 'role', role: 'chef' }),
      }),
      {
        wrapper: ({ children }) => (
          <KakiConnectionProvider role="chef" sharedAudience="screen">
            {children}
          </KakiConnectionProvider>
        ),
      },
    );

    expect(sockets).toHaveLength(3);
    expect(sockets.filter((socket) => socket.url.includes('audience=lifecycle'))).toHaveLength(1);
    expect(sockets.filter((socket) => socket.url.includes('audience=screen'))).toHaveLength(1);
    expect(sockets.filter((socket) => socket.url.includes('role=chef'))).toHaveLength(1);

    act(() => {
      for (const socket of sockets) socket.emit('open');
    });
    await waitFor(() => expect(result.current.screenA.connected).toBe(true));
    expect(result.current.screenB.connected).toBe(true);
    expect(result.current.roleA.connected).toBe(true);
    expect(result.current.roleB.connected).toBe(true);
    expect(result.current.lifecycle.connected).toBe(true);
  });

  it('routes each feed to its consumers and keeps another feed out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetingId: 'meeting-a', started: false }),
    })));
    const { useKaki } = await import('./useKaki');
    const { KakiConnectionProvider } = await import('./connection');
    const { result } = renderMeetingHook(
      () => ({
        lifecycle: useKaki({ kind: 'lifecycle' }),
        screen: useKaki({ kind: 'screen' }),
        role: useKaki({ kind: 'role', role: 'chef' }),
      }),
      {
        wrapper: ({ children }) => (
          <KakiConnectionProvider role="chef" sharedAudience="screen">
            {children}
          </KakiConnectionProvider>
        ),
      },
    );
    const lifecycle = socketFor('audience=lifecycle');
    const screen = socketFor('audience=screen');
    const role = socketFor('role=chef');
    act(() => {
      for (const socket of sockets) socket.emit('open');
    });

    act(() => lifecycle.emit('message', startEvent('meeting-a')));
    act(() => screen.emit('message', taskEvent('shared', 'Shared card', { kind: 'screen' })));
    act(() => role.emit('message', taskEvent('mine', 'My card', { kind: 'role', role: 'chef' })));

    await waitFor(() => expect(result.current.lifecycle.started).toBe(true));
    await waitFor(() => expect(result.current.screen.tasks.size).toBe(1));
    await waitFor(() => expect(result.current.role.tasks.size).toBe(1));
    expect(result.current.role.tasks.has('mine')).toBe(true);
    expect(result.current.screen.tasks.has('shared')).toBe(true);
    expect(result.current.screen.tasks.has('mine')).toBe(false);
  });

  it('reconnects only the dropped feed and replays its retained event once per consumer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetingId: 'meeting-a', started: true }),
    })));
    const { useKaki } = await import('./useKaki');
    const { KakiConnectionProvider } = await import('./connection');
    const { result } = renderMeetingHook(
      () => ({
        screenA: useKaki({ kind: 'screen' }),
        screenB: useKaki({ kind: 'screen' }),
        role: useKaki({ kind: 'role', role: 'chef' }),
      }),
      {
        wrapper: ({ children }) => (
          <KakiConnectionProvider role="chef" sharedAudience="screen">
            {children}
          </KakiConnectionProvider>
        ),
      },
    );
    const first = socketFor('audience=screen');
    act(() => first.emit('open'));
    act(() => first.emit('message', transcriptEvent('Ada', 'Before the drop.', 'chef')));
    await waitFor(() => expect(result.current.screenA.events).toHaveLength(1));
    expect(result.current.screenB.events).toHaveLength(1);

    act(() => (first as unknown as { close(): void }).close());
    await waitFor(
      () => expect(sockets.filter((socket) => socket.url.includes('audience=screen'))).toHaveLength(2),
      { timeout: 2_000 },
    );
    const second = sockets.find(
      (socket) => socket.url.includes('audience=screen') && socket !== first,
    )!;
    expect(sockets.filter((socket) => socket.url.includes('role=chef'))).toHaveLength(1);
    expect(sockets.filter((socket) => socket.url.includes('audience=lifecycle'))).toHaveLength(1);

    act(() => second.emit('open'));
    act(() => second.emit('message', {
      data: JSON.stringify({
        type: 'TRANSCRIPT_CHUNK',
        audience: { kind: 'all' },
        payload: { speaker: 'Ada', text: 'Replayed after the drop.', timestamp: new Date().toISOString() },
        replayed: true,
      }),
    }));

    await waitFor(() =>
      expect(result.current.screenA.events.some((event) => event.type === 'TRANSCRIPT_CHUNK')).toBe(true),
    );
    expect(result.current.screenA.events).toHaveLength(1);
    expect(result.current.screenB.events).toHaveLength(1);
    expect(result.current.role.events).toHaveLength(0);
  });

  it('sends each command on the socket of the feed that made it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ meetingId: 'meeting-a', started: false }),
    })));
    const { useKaki } = await import('./useKaki');
    const { KakiConnectionProvider } = await import('./connection');
    const { result } = renderMeetingHook(
      () => ({
        screen: useKaki({ kind: 'screen' }),
        role: useKaki({ kind: 'role', role: 'chef' }),
      }),
      {
        wrapper: ({ children }) => (
          <KakiConnectionProvider role="chef" sharedAudience="screen">
            {children}
          </KakiConnectionProvider>
        ),
      },
    );
    const screen = socketFor('audience=screen');
    const role = socketFor('role=chef');
    act(() => {
      screen.emit('open');
      role.emit('open');
    });

    act(() => expect(result.current.screen.send({ type: 'NEXT_AGENDA_ITEM' })).toBe(true));
    act(() => expect(result.current.role.send({ type: 'CLAIM_TASK', taskId: 't1', mode: 'MANUAL' })).toBe(true));

    expect(JSON.parse(screen.sent[0]!)).toMatchObject({ type: 'NEXT_AGENDA_ITEM' });
    expect(screen.sent).toHaveLength(1);
    expect(JSON.parse(role.sent[0]!)).toMatchObject({ type: 'CLAIM_TASK', taskId: 't1' });
    expect(role.sent).toHaveLength(1);
  });
});
