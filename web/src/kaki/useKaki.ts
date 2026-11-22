import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isKakiEvent,
  MEETING_ENDED_MESSAGE,
  type KakiCommand,
  type KakiEvent,
  type MeetingStateSnapshot,
  type Role,
  type Task,
  type WingmanNotePayload,
} from '@kaki/shared';
import { fetchMe } from '../auth/api';
import { meetingApiPath, useMeetingScope } from './meetingScope';
import { useScenario } from './ScenarioContext';
import { invalidateScenario, noteMeetingIdentity } from './scenarioRevision';
import { addTopicSpeech, type TopicSpeech } from './topicSpeech';

export type { TopicSpeech } from './topicSpeech';

type HumanLineCommand = Extract<KakiCommand, { type: 'HUMAN_LINE' }>;

/** A typed line waiting for the socket, with the meeting it was typed in so a reconnect can check it. */
interface PendingLine {
  command: HumanLineCommand;
  meetingId: string | undefined;
}

/** A command the server refused, with the reason to show the user. */
export interface KakiRejection {
  commandType: string;
  reason: string;
  /** The words the person typed, when the app could not send them, so the box can offer them again. */
  text?: string;
}

/** The server's latest record for the meeting, including the agenda item it is on and its pause. */
type MeetingRecordEvent = Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>;

/** The live meeting state one page needs: non-task events, tasks, rejections and a send function. */
export interface UseKakiResult {
  events: KakiEvent[];
  /** The newest MEETING_RECORD_UPDATED, kept outside the short event window so it is never lost. */
  latestRecord: MeetingRecordEvent | undefined;
  /**
   * Who has spoken on each agenda item, keyed by the item that was current when each line arrived.
   * Kept outside the short event window so a topic's speech is not forgotten between records.
   */
  speechByTopic: ReadonlyMap<number, TopicSpeech>;
  tasks: Map<string, Task>;
  /** The person's own private Wingman notes, newest last; a cleared note is removed. */
  wingmanNotes: WingmanNotePayload[];
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
  /** The latest real-meeting state: who is here, off the record, notes paused and the agenda note. */
  meetingState: MeetingStateSnapshot | undefined;
  /** A message from the server explaining why this feed was closed for good, if it was. */
  ended: string | undefined;
  /** True when the command went out on an open socket; false when it was refused locally. */
  send(command: KakiCommand): boolean;
  /** Ask this person's private Wingman a question about the meeting. */
  askWingman(question: string): boolean;
}

/** Which feed to follow: a role's own seat, or one of the read-only shared feeds. */
export type KakiAudience =
  | { kind: 'role'; role: Role }
  | { kind: 'screen' }
  | { kind: 'lifecycle' }
  | { kind: 'participant' };

/** Subscribe to the server for one audience and keep the task list up to date. */
export function useKaki(audience: KakiAudience): UseKakiResult {
  const scenario = useScenario();
  const { meetingId: scopeMeetingId } = useMeetingScope();
  /** The scenario is only used to validate messages; a new plan must not tear down a live socket. */
  const scenarioRef = useRef(scenario);
  scenarioRef.current = scenario;
  const audienceKind = audience.kind;
  const audienceRole = audience.kind === 'role' ? audience.role : undefined;
  const [events, setEvents] = useState<KakiEvent[]>([]);
  const [latestRecord, setLatestRecord] = useState<MeetingRecordEvent | undefined>(undefined);
  const [speechByTopic, setSpeechByTopic] = useState<ReadonlyMap<number, TopicSpeech>>(() => new Map());
  const [tasks, setTasks] = useState<Map<string, Task>>(() => new Map());
  const [wingmanNotes, setWingmanNotes] = useState<WingmanNotePayload[]>([]);
  const [rejections, setRejections] = useState<KakiRejection[]>([]);
  const [connected, setConnected] = useState(false);
  const [restoredAt, setRestoredAt] = useState<string | undefined>(undefined);
  const [started, setStarted] = useState<boolean | undefined>(undefined);
  /** The lifecycle value this socket last saw, so a retained START on reconnect is not a new transition. */
  const startedRef = useRef<boolean | undefined>(undefined);
  const [meetingIdentity, setMeetingIdentity] = useState<string | undefined>(undefined);
  const [meetingState, setMeetingState] = useState<MeetingStateSnapshot | undefined>(undefined);
  const [ended, setEnded] = useState<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const attempts = useRef(0);
  /** Bumped by every lifecycle event so a slow state fetch cannot overwrite newer news. */
  const lifecycleRevision = useRef(0);
  /** The newest meeting the browser has seen, so an answer for an older one is thrown away. */
  const meetingId = useRef<string | undefined>(undefined);
  /** The newest record read synchronously, so a line is filed under the topic it arrived on. */
  const latestRecordRef = useRef<MeetingRecordEvent | undefined>(undefined);
  /** Typed lines written while the socket is reconnecting; they go out once catch-up confirms the meeting. */
  const pendingLines = useRef<PendingLine[]>([]);
  /** The audience the queued lines were typed for; a changed seat/audience drops them. */
  const queuedAudience = useRef(`${audienceKind}:${audienceRole ?? ''}`);

  useEffect(() => {
    const currentAudience = `${audienceKind}:${audienceRole ?? ''}`;
    /** Tell the person about words that cannot go out, instead of dropping them without a trace. */
    function refuseHeldLines(entries: readonly PendingLine[], reason: string): void {
      if (entries.length === 0) return;
      setRejections((previous) =>
        [
          ...previous,
          ...entries.map((entry) => ({
            commandType: 'HUMAN_LINE' as const,
            reason,
            text: entry.command.text,
          })),
        ].slice(-5),
      );
    }

    let refusedOnAudienceChange: PendingLine[] = [];
    if (queuedAudience.current !== currentAudience) {
      // The same browser tab changed seat (or left the screen): a held line belonged to the old
      // speaker, so it must never go out as this one. The person gets their words back below,
      // after this run has cleared the previous seat's state.
      refusedOnAudienceChange = pendingLines.current;
      pendingLines.current = [];
      queuedAudience.current = currentAudience;
      meetingId.current = undefined;
    }
    setEvents([]);
    setLatestRecord(undefined);
    latestRecordRef.current = undefined;
    setSpeechByTopic(new Map());
    setTasks(new Map());
    setWingmanNotes([]);
    setRejections([]);
    setConnected(false);
    setRestoredAt(undefined);
    setMeetingIdentity(undefined);
    setMeetingState(undefined);
    setEnded(undefined);
    if (refusedOnAudienceChange.length > 0) {
      refuseHeldLines(refusedOnAudienceChange, 'Your seat changed before your line was sent.');
    }
    attempts.current = 0;
    let closed = false;
    let endedForGood = false;
    let opened = false;
    let socket: WebSocket | undefined;

    /**
     * Send the lines held while the socket was down, once catch-up names the meeting. A line typed
     * before its meeting id was known is bound to the meeting that catch-up names; a line typed in
     * a different meeting is refused out loud. Every line leaves at most once.
     */
    function flushHeldLines(target: WebSocket, currentMeetingId: string | undefined): void {
      if (pendingLines.current.length === 0 || currentMeetingId === undefined) return;
      const queue = pendingLines.current;
      pendingLines.current = [];
      for (const entry of queue) {
        if (entry.meetingId !== undefined && entry.meetingId !== currentMeetingId) {
          refuseHeldLines([entry], 'Your line was for a different meeting, so it was not sent.');
          continue;
        }
        if (target.readyState !== WebSocket.OPEN) {
          pendingLines.current.push(entry);
          continue;
        }
        target.send(JSON.stringify({ ...entry.command, meetingId: currentMeetingId }));
      }
    }

    function connect(): void {
      if (closed || endedForGood) return;
      opened = false;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Roles and shared feeds travel on separate channels: a role id may be any word, including
      // `participant`, so it can never be mistaken for the projection by its spelling.
      const channel =
        audienceRole === undefined
          ? `audience=${encodeURIComponent(audienceKind)}`
          : `role=${encodeURIComponent(audienceRole)}`;
      const meetingQuery =
        scopeMeetingId === undefined || scopeMeetingId === ''
          ? ''
          : `&meeting=${encodeURIComponent(scopeMeetingId)}`;
      const url = `${protocol}//${window.location.host}/ws?${channel}${meetingQuery}`;
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
        latestRecordRef.current = undefined;
        setTasks(new Map());
        setWingmanNotes([]);
        setRestoredAt(undefined);
        setMeetingIdentity(undefined);
        setMeetingState(undefined);
        setEnded(undefined);
        setConnected(true);
        // A held line goes out only after the server's catch-up names the meeting it was typed in.
        // A reset may also have happened while this tab was disconnected, so ask instead of guessing.
        const askedOn = current;
        const askedAtRevision = lifecycleRevision.current;
        const knownBefore = meetingId.current;
        if (audienceKind === 'lifecycle') meetingId.current = undefined;
        void fetch(meetingApiPath(scopeMeetingId, '/api/meeting/state'))
          .then(async (response) => {
            const body = (await response.json().catch(() => ({}))) as {
              meetingId?: unknown;
              started?: unknown;
              kind?: unknown;
            };
            if (!response.ok || typeof body.started !== 'boolean') return;
            if (typeof body.meetingId !== 'string' || body.meetingId === '') return;
            // Only the connection that is still current may apply an answer, and only for the
            // newest meeting: a fetch from a closed or replaced socket belongs to the past.
            if (closed || socketRef.current !== askedOn || askedOn.readyState !== WebSocket.OPEN) return;
            // A start/reset event that arrived while this answer was in flight is newer.
            if (lifecycleRevision.current !== askedAtRevision) return;
            if (
              audienceKind === 'lifecycle' &&
              meetingId.current !== undefined &&
              meetingId.current !== body.meetingId
            ) {
              return;
            }
            // The room came back as a different meeting: the old queue can never go into it.
            if (knownBefore !== undefined && knownBefore !== body.meetingId) {
              refuseHeldLines(pendingLines.current, 'The meeting changed before your line was sent.');
              pendingLines.current = [];
            }
            meetingId.current = body.meetingId;
            if (audienceKind === 'lifecycle') {
              noteMeetingIdentity({
                meetingId: body.meetingId,
                ...(body.kind === 'real' || body.kind === 'practice' ? { kind: body.kind } : {}),
              });
              startedRef.current = body.started;
              setStarted(body.started);
            }
            if (body.started === true) flushHeldLines(askedOn, body.meetingId);
          })
          .catch((error: unknown) => {
            console.warn('kaki web: could not read the meeting lifecycle state', error);
          });
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
        if (!isKakiEvent(parsed, scenarioRef.current)) {
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

        if (parsed.type === 'WINGMAN_NOTE') {
          const note = parsed.payload;
          setWingmanNotes((previous) => {
            const without = previous.filter((candidate) => candidate.id !== note.id);
            return note.clears === true ? without : [...without, note];
          });
          return;
        }

        if (parsed.type === 'MEETING_STARTED') {
          const isNewMeeting = meetingId.current !== parsed.payload.meetingId;
          lifecycleRevision.current += 1;
          meetingId.current = parsed.payload.meetingId;
          setMeetingIdentity(parsed.payload.meetingId);
          noteMeetingIdentity({ meetingId: parsed.payload.meetingId });
          // Start seals the plan, so the browser's scenario is now a different meeting's. The
          // transition (not the event) is what reloads it: a reconnect replays this retained event.
          if (startedRef.current !== true) invalidateScenario();
          startedRef.current = true;
          setStarted(true);
          if (isNewMeeting) {
            latestRecordRef.current = undefined;
            setSpeechByTopic(new Map());
          }
          // The retained START is the authoritative catch-up for a held line: only this meeting's
          // line goes out, and a line from another meeting is dropped, never sent to this one.
          flushHeldLines(current, parsed.payload.meetingId);
        }

        if (parsed.type === 'MEETING_RESET') {
          // A queued line belongs to the meeting that just ended; never write it into the next one.
          refuseHeldLines(pendingLines.current, 'The meeting ended before your line was sent.');
          pendingLines.current = [];
          lifecycleRevision.current += 1;
          meetingId.current = parsed.payload.meetingId;
          setMeetingIdentity(parsed.payload.meetingId);
          noteMeetingIdentity({ meetingId: parsed.payload.meetingId });
          if (startedRef.current === true) invalidateScenario();
          startedRef.current = false;
          setStarted(false);
          setLatestRecord(undefined);
          latestRecordRef.current = undefined;
          setSpeechByTopic(new Map());
          setMeetingState(undefined);
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
          setWingmanNotes([]);
          setRestoredAt(undefined);
          return;
        }

        if (parsed.type === 'MEETING_RESTORED') {
          lifecycleRevision.current += 1;
          setRestoredAt(parsed.payload.startedAt);
          startedRef.current = true;
          setStarted(true);
          return;
        }

        if (parsed.type === 'MEETING_STATE') {
          setMeetingState(parsed.payload);
          return;
        }

        if (parsed.type === 'COMMAND_REJECTED') {
          setRejections((previous) => [...previous, parsed.payload].slice(-5));
          return;
        }

        // Keep the newest record in its own state: it is the source of the agenda and pause, and it
        // must outlive the 50-event window that older transcript lines push it out of.
        if (parsed.type === 'MEETING_RECORD_UPDATED') {
          latestRecordRef.current = parsed;
          setLatestRecord(parsed);
        }

        // File each line under the topic it arrived on, not under whichever record survives the
        // 50-event window. Seats are exact; names are only a fallback for lines with no seat.
        if (parsed.type === 'TRANSCRIPT_CHUNK') {
          const agendaIndex = latestRecordRef.current?.payload.agendaIndex ?? 0;
          setSpeechByTopic((previous) => addTopicSpeech(previous, agendaIndex, parsed));
        }

        setEvents((previous) => [...previous, Object.assign(parsed, { receivedAt: Date.now() })].slice(-50));
      });

      current.addEventListener('close', (event) => {
        if (closed || endedForGood) return;
        setConnected(false);
        const closeEvent = event as CloseEvent | undefined;
        if (closeEvent?.code === 4001) {
          endedForGood = true;
          refuseHeldLines(pendingLines.current, 'The meeting ended before your line was sent.');
          pendingLines.current = [];
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
              if (me.authEnabled && me.kind === null && me.ended === true) {
                endedForGood = true;
                refuseHeldLines(pendingLines.current, 'The meeting ended before your line was sent.');
                pendingLines.current = [];
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
  }, [audienceKind, audienceRole, scopeMeetingId]);

  const send = useCallback((command: KakiCommand): boolean => {
    const socket = socketRef.current;
    // A line is always bound to the meeting and seat it was written for, so a held line can never
    // surface in the next meeting or under another speaker.
    const line: KakiCommand =
      command.type === 'HUMAN_LINE'
        ? {
            ...command,
            ...(meetingId.current === undefined ? {} : { meetingId: meetingId.current }),
            ...(audienceRole === undefined ? {} : { seat: audienceRole }),
          }
        : command;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      // A person's words are not a control command: hold a typed line until catch-up confirms the
      // same meeting, so a reconnect at Start never swallows it. The server writes one clientLineId once.
      if (line.type === 'HUMAN_LINE') {
        pendingLines.current = [
          ...pendingLines.current,
          { command: line, meetingId: meetingId.current },
        ].slice(-20);
        return true;
      }
      setRejections((previous) =>
        [...previous, { commandType: command.type, reason: 'not connected' }].slice(-5),
      );
      return false;
    }
    try {
      socket.send(JSON.stringify(line));
    } catch {
      // A socket that failed as it was closing must not swallow a person's words.
      if (line.type === 'HUMAN_LINE') {
        pendingLines.current = [
          ...pendingLines.current,
          { command: line, meetingId: meetingId.current },
        ].slice(-20);
        return true;
      }
      setRejections((previous) =>
        [...previous, { commandType: command.type, reason: 'not connected' }].slice(-5),
      );
      return false;
    }
    return true;
  }, [audienceRole]);

  const askWingman = useCallback(
    (question: string): boolean => send({ type: 'ASK_WINGMAN', question }),
    [send],
  );

  return {
    events,
    latestRecord,
    speechByTopic,
    tasks,
    wingmanNotes,
    rejections,
    rejection: rejections[rejections.length - 1] ?? null,
    connected,
    restoredAt,
    started,
    meetingId: meetingIdentity,
    meetingState,
    ended,
    send,
    askWingman,
  };
}
