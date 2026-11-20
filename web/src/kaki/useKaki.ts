import { useCallback, useEffect, useRef, useState } from 'react';
import { isKakiEvent, type KakiCommand, type KakiEvent, type Role, type Task } from '@kaki/shared';
import { fetchMe } from '../auth/api';
import { useScenario } from './ScenarioContext';

/** What the server says when a phone's meeting code has been replaced. */
const MEETING_ENDED_MESSAGE = 'This meeting has ended; scan the new code.';

/** A command the server refused, with the reason to show the user. */
export interface KakiRejection {
  commandType: string;
  reason: string;
}

/** The server's latest record for the meeting, including the agenda item it is on and its pause. */
export type MeetingRecordEvent = Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>;

/** The live meeting state one page needs: non-task events, tasks, rejections and a send function. */
export interface UseKakiResult {
  events: KakiEvent[];
  /** The newest MEETING_RECORD_UPDATED, kept outside the short event window so it is never lost. */
  latestRecord: MeetingRecordEvent | undefined;
  tasks: Map<string, Task>;
  rejections: KakiRejection[];
  rejection: KakiRejection | null;
  connected: boolean;
  /** When the server restored this meeting after a restart, its start time; otherwise undefined. */
  restoredAt: string | undefined;
  /**
   * The server's explicit lifecycle state: true after MEETING_STARTED, false after MEETING_RESET.
   * Undefined until the server says either, so reconnecting never guesses from a cleared event list.
   */
  started: boolean | undefined;
  /** The current meeting identity, so a join card can reload its code when a new meeting starts. */
  meetingId: string | undefined;
  /** A message from the server explaining why this feed was closed for good, if it was. */
  ended: string | undefined;
  /** True when the command went out on an open socket; false when it was refused locally. */
  send(command: KakiCommand): boolean;
}

/** Subscribe to the server for one audience and keep the task list up to date. */
export function useKaki(audience: 'screen' | Role | 'lifecycle'): UseKakiResult {
  const scenario = useScenario();
  const [events, setEvents] = useState<KakiEvent[]>([]);
  const [latestRecord, setLatestRecord] = useState<MeetingRecordEvent | undefined>(undefined);
  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map());
  const [rejections, setRejections] = useState<KakiRejection[]>([]);
  const [connected, setConnected] = useState(false);
  const [restoredAt, setRestoredAt] = useState<string | undefined>(undefined);
  const [started, setStarted] = useState<boolean | undefined>(undefined);
  const [meetingIdentity, setMeetingIdentity] = useState<string | undefined>(undefined);
  const [ended, setEnded] = useState<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const attempts = useRef(0);
  /** Bumped by every lifecycle event so a slow state fetch cannot overwrite newer news. */
  const lifecycleRevision = useRef(0);
  /** The newest meeting the browser has seen, so an answer for an older one is thrown away. */
  const meetingId = useRef<string | undefined>(undefined);

  useEffect(() => {
    setEvents([]);
    setLatestRecord(undefined);
    setTasks(new Map());
    setRejections([]);
    setConnected(false);
    setRestoredAt(undefined);
    setMeetingIdentity(undefined);
    setEnded(undefined);
    attempts.current = 0;
    let closed = false;
    let endedForGood = false;
    let opened = false;
    let socket: WebSocket | undefined;

    function connect(): void {
      if (closed || endedForGood) return;
      opened = false;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${window.location.host}/ws?role=${encodeURIComponent(audience)}`;
      const current = new WebSocket(url);
      socket = current;
      socketRef.current = current;

      current.addEventListener('open', () => {
        if (closed) return;
        opened = true;
        attempts.current = 0;
        // The server is the source of truth: drop local state and rebuild from its catch-up,
        // so a restarted server never leaves stale task cards on screen.
        setEvents([]);
        setLatestRecord(undefined);
        setTasks(new Map());
        setRestoredAt(undefined);
        setMeetingIdentity(undefined);
        setEnded(undefined);
        setConnected(true);
        if (audience === 'lifecycle') {
          // A reset may have happened while this tab was disconnected; ask instead of inferring.
          const askedOn = current;
          const askedAtRevision = lifecycleRevision.current;
          meetingId.current = undefined;
          void fetch('/api/meeting/state')
            .then(async (response) => {
              const body = (await response.json().catch(() => ({}))) as {
                meetingId?: unknown;
                started?: unknown;
              };
              if (!response.ok || typeof body.started !== 'boolean') return;
              if (typeof body.meetingId !== 'string' || body.meetingId === '') return;
              // Only the connection that is still current may apply an answer, and only for the
              // newest meeting: a fetch from a closed or replaced socket belongs to the past.
              if (closed || socketRef.current !== askedOn || askedOn.readyState !== WebSocket.OPEN) return;
              // A start/reset event that arrived while this answer was in flight is newer.
              if (lifecycleRevision.current !== askedAtRevision) return;
              if (meetingId.current !== undefined && meetingId.current !== body.meetingId) return;
              meetingId.current = body.meetingId;
              setStarted(body.started);
            })
            .catch((error: unknown) => {
              console.warn('kaki web: could not read the meeting lifecycle state', error);
            });
        }
      });

      current.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data) as unknown;
        } catch {
          console.warn('kaki web: ignored a non-JSON message');
          return;
        }
        if (!isKakiEvent(parsed, scenario)) {
          console.warn('kaki web: ignored an invalid event', parsed);
          return;
        }

        if (parsed.type === 'TASK_UPDATED') {
          const task = parsed.payload.task;
          setTasks((previous) => {
            const next = new Map(previous);
            next.set(task.id, task);
            return next;
          });
          return;
        }

        if (parsed.type === 'MEETING_STARTED') {
          lifecycleRevision.current += 1;
          meetingId.current = parsed.payload.meetingId;
          setMeetingIdentity(parsed.payload.meetingId);
          setStarted(true);
        }

        if (parsed.type === 'MEETING_RESET') {
          lifecycleRevision.current += 1;
          meetingId.current = parsed.payload.meetingId;
          setMeetingIdentity(parsed.payload.meetingId);
          setStarted(false);
          setLatestRecord(undefined);
          setEvents((previous) => {
            const last = previous.at(-1);
            // When a new meeting starts on its first transcript line, the hub sends that line just before
            // the host module publishes MEETING_RESET; keep it so the opening caption is not wiped.
            if (last?.type === 'TRANSCRIPT_CHUNK' && Date.now() - Date.parse(last.payload.timestamp) < 2000) {
              return [last];
            }
            return [];
          });
          setTasks(new Map());
          setRestoredAt(undefined);
          return;
        }

        if (parsed.type === 'MEETING_RESTORED') {
          lifecycleRevision.current += 1;
          setRestoredAt(parsed.payload.startedAt);
          setStarted(true);
          return;
        }

        if (parsed.type === 'COMMAND_REJECTED') {
          setRejections((previous) => [...previous, parsed.payload].slice(-5));
          return;
        }

        // Keep the newest record in its own state: it is the source of the agenda and pause, and it
        // must outlive the 50-event window that older transcript lines push it out of.
        if (parsed.type === 'MEETING_RECORD_UPDATED') setLatestRecord(parsed);

        setEvents((previous) => [...previous, Object.assign(parsed, { receivedAt: Date.now() })].slice(-50));
      });

      current.addEventListener('close', (event) => {
        if (closed || endedForGood) return;
        setConnected(false);
        const closeEvent = event as CloseEvent | undefined;
        if (closeEvent?.code === 4001) {
          endedForGood = true;
          if (reconnectTimer.current !== undefined) {
            window.clearTimeout(reconnectTimer.current);
            reconnectTimer.current = undefined;
          }
          setEnded(closeEvent.reason === '' ? MEETING_ENDED_MESSAGE : closeEvent.reason);
          return;
        }
        if (!opened) {
          // A reconnect was refused before it opened. Ask whether this phone's meeting is gone;
          // otherwise the backoff below keeps retrying at a bounded pace.
          void fetchMe()
            .then((me) => {
              if (closed || endedForGood) return;
              if (me.authEnabled && me.kind === null && me.reason === MEETING_ENDED_MESSAGE) {
                endedForGood = true;
                if (reconnectTimer.current !== undefined) {
                  window.clearTimeout(reconnectTimer.current);
                  reconnectTimer.current = undefined;
                }
                socket?.close();
                setEnded(MEETING_ENDED_MESSAGE);
              }
            })
            .catch((error: unknown) => {
              console.warn('kaki web: could not re-check the session after a failed reconnect', error);
            });
        }
        if (endedForGood) return;
        const delay = Math.min(5000, 500 * 2 ** attempts.current);
        attempts.current += 1;
        reconnectTimer.current = window.setTimeout(connect, delay);
      });

      current.addEventListener('error', () => current.close());
    }

    connect();

    return () => {
      closed = true;
      if (reconnectTimer.current !== undefined) {
        window.clearTimeout(reconnectTimer.current);
        reconnectTimer.current = undefined;
      }
      socket?.close();
      socketRef.current = undefined;
    };
  }, [audience, scenario]);

  const send = useCallback((command: KakiCommand): boolean => {
    const socket = socketRef.current;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      setRejections((previous) =>
        [...previous, { commandType: command.type, reason: 'not connected' }].slice(-5),
      );
      return false;
    }
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  return {
    events,
    latestRecord,
    tasks,
    rejections,
    rejection: rejections[rejections.length - 1] ?? null,
    connected,
    restoredAt,
    started,
    meetingId: meetingIdentity,
    ended,
    send,
  };
}
