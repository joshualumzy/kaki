/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { KakiAudience } from './useKaki';
import { MEETING_ENDED_MESSAGE } from '@kaki/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'lifecycle' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    await waitFor(() => expect(result.current.started).toBe(false));
    expect(fetchMock).toHaveBeenCalledWith('/api/meeting/state');
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
    const { result } = renderHook(() => useKaki({ kind: 'lifecycle' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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
    const { result, rerender } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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

  it('sends a line typed before the meeting id is known once catch-up names the meeting', async () => {
    const answers: Array<(value: unknown) => void> = [];
    vi.stubGlobal('fetch', vi.fn(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    ));
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]! as unknown as {
      readyState: number;
      emit(type: string, event?: unknown): void;
      sent: string[];
    };
    // The socket is still opening and this feed has not heard any meeting id yet (a page that
    // mounted during Start). The person's line must not be thrown away for that.
    first.readyState = 0;
    act(() => {
      expect(result.current.send({
        type: 'HUMAN_LINE',
        text: 'I will confirm the stock count before lunch.',
        source: 'typed',
        clientLineId: 'no-id-yet',
      })).toBe(true);
    });
    first.readyState = 1;
    act(() => first.emit('open'));
    await waitFor(() => expect(answers).toHaveLength(1));
    await act(async () => {
      answers[0]!({
        ok: true,
        status: 200,
        json: async () => ({ meetingId: 'meeting-a', started: true }),
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(first.sent.map((message) => JSON.parse(message).type)).toContain('HUMAN_LINE'),
    );
    const sentLine = JSON.parse(first.sent.find((message) => JSON.parse(message).type === 'HUMAN_LINE')!);
    expect(sentLine.meetingId).toBe('meeting-a');
    expect(sentLine.seat).toBe('chef');
    expect(result.current.rejection).toBeNull();
  });

  it('holds a typed line across a reconnect and sends it only after catch-up confirms the meeting', async () => {
    const answers: Array<(value: unknown) => void> = [];
    vi.stubGlobal('fetch', vi.fn(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    ));
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;
    act(() => first.emit('open'));
    act(() => first.emit('message', startEvent('meeting-a')));
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => (first as unknown as { close(): void }).close());
    act(() => {
      expect(result.current.send({
        type: 'HUMAN_LINE',
        text: 'I will confirm the stock count before lunch.',
        source: 'typed',
        clientLineId: 'held-line',
      })).toBe(true);
    });
    expect(result.current.rejection).toBeNull();

    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const second = sockets[1]! as unknown as {
      emit(type: string, event?: unknown): void;
      sent: string[];
    };
    act(() => second.emit('open'));
    // Opening alone is not catch-up: the line must wait for the server's meeting identity.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.sent).toEqual([]);
    await act(async () => {
      answers[1]!({
        ok: true,
        status: 200,
        json: async () => ({ meetingId: 'meeting-a', started: true }),
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(second.sent.map((message) => JSON.parse(message).type)).toContain('HUMAN_LINE'));
    const sentLine = JSON.parse(second.sent.find((message) => JSON.parse(message).type === 'HUMAN_LINE')!);
    expect(sentLine.meetingId).toBe('meeting-a');
    expect(sentLine.seat).toBe('chef');
  });

  it('drops a held line when the room comes back as a different meeting', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
    const first = sockets[0]!;
    act(() => first.emit('open'));
    act(() => first.emit('message', startEvent('meeting-a')));
    act(() => (first as unknown as { close(): void }).close());
    act(() => {
      expect(result.current.send({
        type: 'HUMAN_LINE',
        text: 'This belonged to meeting A.',
        source: 'typed',
        clientLineId: 'held-line',
      })).toBe(true);
    });

    await waitFor(() => expect(sockets[1]).toBeDefined(), { timeout: 2_000 });
    const second = sockets[1]! as unknown as { emit(type: string, event?: unknown): void; sent: string[] };
    act(() => second.emit('open'));
    act(() => second.emit('message', startEvent('meeting-b')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.sent).toEqual([]);
    expect(result.current.rejection).toMatchObject({
      commandType: 'HUMAN_LINE',
      text: 'This belonged to meeting A.',
      reason: expect.stringMatching(/different meeting/i),
    });
  });

  it('drops a held line when the audience changes', async () => {
    const { useKaki } = await import('./useKaki');
    const { result, rerender } = renderHook(({ audience }) => useKaki(audience), {
      initialProps: { audience: { kind: 'role', role: 'chef' } as KakiAudience },
    });
    const first = sockets[0]!;
    act(() => first.emit('open'));
    act(() => first.emit('message', startEvent('meeting-a')));
    act(() => (first as unknown as { close(): void }).close());
    act(() => {
      expect(result.current.send({
        type: 'HUMAN_LINE',
        text: 'Typed as the chef.',
        source: 'typed',
        clientLineId: 'held-line',
      })).toBe(true);
    });

    rerender({ audience: { kind: 'role', role: 'operations_director' } });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(1), { timeout: 2_000 });
    const second = sockets[sockets.length - 1]! as unknown as {
      emit(type: string, event?: unknown): void;
      sent: string[];
    };
    act(() => second.emit('open'));
    act(() => second.emit('message', startEvent('meeting-a')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.sent).toEqual([]);
    expect(result.current.rejection).toMatchObject({
      commandType: 'HUMAN_LINE',
      text: 'Typed as the chef.',
    });
  });

  it('keeps the newest meeting record even after it leaves the event window', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki({ kind: 'screen' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'participant' }));
    const socket = sockets[0]!;
    act(() => socket.emit('open'));

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.')));
    await waitFor(() => expect(result.current.wingmanNotes).toHaveLength(1));
    expect(result.current.wingmanNotes[0]).toMatchObject({ id: 'answer:chef', text: 'A private answer.' });

    act(() => socket.emit('message', noteMessage('answer:chef', 'A private answer.', true)));
    await waitFor(() => expect(result.current.wingmanNotes).toHaveLength(0));
  });

  it('sends ASK_WINGMAN to the server for this seat', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki({ kind: 'role', role: 'chef' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'screen' }));
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
    const { result } = renderHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', recordEvent(1)));
    act(() => socket.emit('message', transcriptEvent('Other Person', 'Stock is fine.', 'host')));

    await waitFor(() => expect(result.current.speechByTopic.get(1)?.roles.has('host')).toBe(true));
    expect(result.current.speechByTopic.get(1)?.roles.has('operations_director')).toBe(false);
  });

  it('forgets who spoke when the meeting resets', async () => {
    const { useKaki } = await import('./useKaki');
    const { result } = renderHook(() => useKaki({ kind: 'screen' }));
    const socket = sockets[0]!;

    act(() => socket.emit('open'));
    act(() => socket.emit('message', recordEvent(1)));
    act(() => socket.emit('message', transcriptEvent('Ada', 'One decision.', 'chef')));
    await waitFor(() => expect(result.current.speechByTopic.size).toBeGreaterThan(0));

    act(() => socket.emit('message', resetEvent('meeting-b')));
    await waitFor(() => expect(result.current.speechByTopic.size).toBe(0));
  });
});
