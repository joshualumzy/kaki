import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LiveKitRoom, useRoomContext } from '@livekit/components-react';
import '@livekit/components-styles';
import { ConnectionState, RoomEvent, type RoomOptions } from 'livekit-client';
import { joinSeatRoles } from '@kaki/shared';
import { useMe } from '../../auth/useMe';
import {
  KakiConnectionProvider,
  meetingApiPath,
  useKaki,
  useRefreshScenario,
  useScenario,
} from '../../kaki';
import { failureText } from '../../net/failureText';
import {
  COULD_NOT_JOIN,
  ROOM_CONNECT_PROBLEM,
  plainServerText,
} from '../../net/plainFailure';
import { fetchWithTimeout, TimeoutError } from '../../net/withTimeout';
import { ErrorBoundary } from './ErrorBoundary';
import { JoinForm } from './JoinForm';
import type { MediaChoice } from './MediaPreview';
import { MeetingGrid } from './MeetingGrid';
import { Dock } from './Dock';
import { ConnectedStartPrompt } from './StartPrompt';
import { AudioUnlockPrompt } from './AudioUnlock';
import {
  clearStoredJoin,
  disconnectOutcome,
  formatGraceRemaining,
  readRealJoin,
  readStoredJoin,
  REJOIN_GRACE_MS,
  storeJoin,
  storeRealJoinName,
  storeRealMeetingCode,
  type StoredJoin,
} from './rejoinSession';
import { RealRoomStateProvider } from './realRoom';
import { RealEndedOverlay } from './RealRoomOverlays';
import './practice.css';

/** Echo cancellation is what lets the server tell a person talking over the AI from the AI's own playback. */
const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** Which journey this page is: the practice meeting or a real product meeting. */
type MeetingVariant = 'practice' | 'real';

interface Session {
  token: string;
  serverUrl: string;
  /** The Kaki role id of the attendee this person plays, for their private feed. */
  role: string;
  /** The name they typed to join. */
  name: string;
  /** The devices they joined with. Without the microphone they type to the AI attendees. */
  media: MediaChoice;
  /** The code others need to join this meeting. */
  meetingCode?: string;
}

/** A join the server refused, with the sentence the person is shown. */
class JoinRefused extends Error {}

/** Disconnects from LiveKit immediately when the browser tab refreshes or closes so the seat frees up right away. */
function CleanDisconnectOnUnload() {
  const room = useRoomContext();
  useEffect(() => {
    const onUnload = (): void => {
      void room.disconnect().catch(() => undefined);
    };
    window.addEventListener('pagehide', onUnload);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [room]);
  return null;
}

/** Follow the server's explicit lifecycle state: every tab sees the same start, and a reset undoes it. */
function MeetingLifecycleWatcher({
  onStarted,
  onReset,
}: {
  onStarted(): void;
  onReset(): void;
}) {
  const { started } = useKaki({ kind: 'lifecycle' });
  useEffect(() => {
    if (started === true) onStarted();
    else if (started === false) onReset();
  }, [started, onStarted, onReset]);
  return null;
}

interface HotMeetingData {
  session?: Session;
  pane?: 'meeting' | 'kaki';
  started?: boolean;
  /** The meeting the kept session belongs to, so a reload into another meeting never reuses it. */
  meetingId?: string;
}
const hotData = (import.meta as unknown as { hot?: { data: HotMeetingData } }).hot?.data;

/** The join this tab should return to after a reload or a dropped connection. */
function storedFromSession(session: Session): StoredJoin {
  return {
    name: session.name,
    role: session.role,
    media: session.media,
    ...(session.meetingCode === undefined ? {} : { meetingCode: session.meetingCode }),
  };
}

/**
 * The meeting page. Practice keeps the Kopitiam story and its own Start prompt; a real meeting
 * follows the owner's plan. Both share the stage and the Dock.
 */
export default function Meeting({
  variant = 'practice',
  signedIn = false,
  initialCode,
  meetingId,
  practiceMeetingId,
  onNewPractice,
}: {
  variant?: MeetingVariant;
  initialCode?: string;
  /** A real meeting's row id: its rooms, routes and sockets all live under `/api/meetings/:id`. */
  meetingId?: string;
  /** This visitor's own practice meeting, resolved from their cookie before the room mounts. */
  practiceMeetingId?: string;
  /** True when the visitor is signed in, so their practice minutes can be kept in their history. */
  signedIn?: boolean;
  /** Asks the practice page for a fresh practice meeting, without reloading the page. */
  onNewPractice?: () => void;
}) {
  const scenario = useScenario();
  const practice = variant === 'practice';
  const real = variant === 'real';
  // The meeting id every path, room and socket follows: a real meeting's row, or this visitor's
  // own practice. A page always names exactly one of them.
  const apiMeetingId = (real ? meetingId : practiceMeetingId) ?? '';
  if (apiMeetingId === '') {
    throw new Error('Meeting needs its meeting id');
  }
  // A stored join belongs to one practice meeting, so an old practice is never restored into a new one.
  const joinVariant = practice ? `${variant}.${apiMeetingId}` : variant;
  const auth = useMe(0, real);
  const refreshScenario = useRefreshScenario();
  // The same seats the server offers: the setup's person seats when it names them, else every
  // human seat and the host's chair when a person can take it.
  const roles = useMemo(() => joinSeatRoles(scenario), [scenario]);
  // A hot update keeps the session for the same meeting, but never carries one into another meeting.
  const hotSession = hotData !== undefined && hotData.meetingId === apiMeetingId ? hotData.session : undefined;
  const [session, setSession] = useState<Session | undefined>(() => hotSession);
  // A reload must not throw the person back to the name/seat form: remember the join this tab used
  // and ask the server for a fresh token for the same name and seat.
  const initialStored = useRef<StoredJoin | undefined>(
    hotSession === undefined ? readStoredJoin(joinVariant) : undefined,
  );
  const [restore, setRestore] = useState<StoredJoin | undefined>(initialStored.current);
  const [rejoinState, setRejoinState] = useState<'idle' | 'reconnecting' | 'failed'>(
    initialStored.current === undefined ? 'idle' : 'reconnecting',
  );
  const [rejoinProblem, setRejoinProblem] = useState<string | undefined>();
  const [rejoinDeadline, setRejoinDeadline] = useState<number | undefined>(
    initialStored.current === undefined ? undefined : Date.now() + REJOIN_GRACE_MS,
  );
  const autoRejoinAttempted = useRef(false);
  const [mediaProblem, setMediaProblem] = useState<string | undefined>();
  // Cleared as soon as a drop starts a rejoin, so an unmount cannot start a second join for the same room.
  const activeSession = useRef<Session | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // The server says this visitor's practice is gone (ended or unloaded), so a fresh one is the way on.
  const [practiceRestart, setPracticeRestart] = useState<{ problem: string } | undefined>();
  const [needsCode, setNeedsCode] = useState(false);
  const [pane, setPane] = useState<'meeting' | 'kaki'>(() => hotData?.pane ?? 'meeting');
  const [kakiBadgeCount, setKakiBadgeCount] = useState(0);
  const [wingmanBadgeCount, setWingmanBadgeCount] = useState(0);
  // The AI attendees stay silent until the person has read their briefing and pressed Start.
  const [started, setStarted] = useState<boolean>(() => hotData?.started ?? false);
  useEffect(() => {
    if (hotData !== undefined) {
      hotData.session = session;
      hotData.pane = pane;
      hotData.started = started;
      hotData.meetingId = apiMeetingId;
    }
  }, [session, pane, started, apiMeetingId]);

  useEffect(() => {
    activeSession.current = session;
  }, [session]);

  // A real meeting has no role picker: the signed-in person's Google name (or the guest name the
  // server recorded) is used, and the room takes a free person seat automatically.
  const realMeetingId = real ? meetingId : undefined;
  const storedReal = useMemo(
    () => (realMeetingId === undefined ? {} : readRealJoin(realMeetingId)),
    [realMeetingId],
  );
  const [realNameEntry, setRealNameEntry] = useState('');
  const [realCodeEntry, setRealCodeEntry] = useState(storedReal.code ?? '');
  const [hostCheck, setHostCheck] = useState<'checking' | 'host' | 'guest'>(
    realMeetingId === undefined ? 'guest' : 'checking',
  );
  const [hostCode, setHostCode] = useState<string | undefined>(storedReal.code);
  const [left, setLeft] = useState(false);
  const [leftSession, setLeftSession] = useState<Session | undefined>();
  const realAutoAttempted = useRef(false);
  const signedInName =
    auth.status === 'ready' && auth.me.authEnabled
      ? auth.me.kind === 'user'
        ? auth.me.user.name
        : auth.me.kind === 'guest'
          ? auth.me.name
          : undefined
      : undefined;
  const effectiveRealName = signedInName ?? storedReal.name ?? realNameEntry;
  const effectiveRealCode =
    realCodeEntry.trim() !== '' ? realCodeEntry.trim() : hostCode;
  const isHost = hostCheck === 'host';

  useEffect(() => {
    if (realMeetingId === undefined) return;
    let cancelled = false;
    fetchWithTimeout(meetingApiPath(realMeetingId, '/api/meeting-code'), {}, 8_000)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setHostCheck('guest');
          return;
        }
        const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
        const code = typeof body?.code === 'string' ? body.code.trim() : '';
        if (code !== '') {
          setHostCode(code);
          storeRealMeetingCode(realMeetingId, code);
        }
        setHostCheck('host');
      })
      .catch(() => {
        if (!cancelled) setHostCheck('guest');
      });
    return () => {
      cancelled = true;
    };
  }, [realMeetingId]);

  useEffect(() => {
    if (!real || left || session !== undefined || realAutoAttempted.current) return;
    // A reload that remembered this tab's join is rejoined by the restore effect below; a second,
    // concurrent join here would race it on the rotating seat cookie.
    if (initialStored.current !== undefined) return;
    if (hostCheck === 'checking' || auth.status === 'loading') return;
    if (effectiveRealName === undefined || effectiveRealName.trim() === '') return;
    realAutoAttempted.current = true;
    void join(
      effectiveRealName.trim(),
      roles[0]?.id ?? '',
      { microphone: false, camera: false },
      effectiveRealCode,
      { real: true },
    );
  }, [real, left, session, hostCheck, auth.status, effectiveRealName, effectiveRealCode, roles]);

  const linkCode = useMemo(
    () => initialCode ?? new URLSearchParams(window.location.search).get('code') ?? '',
    [initialCode],
  );
  const markMeetingStarted = useCallback(() => setStarted(true), []);
  const markMeetingReset = useCallback(() => setStarted(false), []);

  const hasAi = (scenario.npcs ?? []).length > 0;
  // A human-only setup names its person seats; those are the seats to offer even with no AI cast.
  const offersSeats = practice ? hasAi || scenario.joinSeats !== undefined : roles.length > 0;
  const seatsError = practice
    ? `${scenario.id} has no AI attendees: add "npcs" to its scenario.json.`
    : 'The meeting owner has not opened any seats yet.';

  async function join(
    name: string,
    roleId: string,
    media: MediaChoice,
    meetingCode?: string,
    options: { reconnecting?: boolean; real?: boolean } = {},
  ): Promise<void> {
    const reconnecting = options.reconnecting === true;
    const realJoin = options.real === true || real;
    if (reconnecting) {
      setRejoinState('reconnecting');
      setRejoinProblem(undefined);
    } else {
      setBusy(true);
      setError(undefined);
    }
    try {
      // A real meeting has no seat picker, so try its person seats in turn until one is free. The
      // first candidate is the one chosen for this person; a refusal before any commit moves on.
      const seats = realJoin
        ? [roleId, ...roles.map((role) => role.id).filter((id) => id !== roleId)]
        : [roleId];
      let joined: { body: Record<string, unknown>; role: string } | undefined;
      let lastProblem: string | undefined;
      for (const seat of seats) {
        const response = await fetchWithTimeout(
          meetingApiPath(apiMeetingId, '/api/livekit/token'),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              participantName: name,
              ...(seat === '' ? {} : { participantRole: seat }),
              ...(meetingCode === undefined || meetingCode === '' ? {} : { meetingCode }),
              ...(!realJoin && practice ? { kind: 'practice' } : {}),
            }),
          },
          12_000,
        );
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (body.needsCode === true) setNeedsCode(true);
        if (response.ok && typeof body.token === 'string') {
          joined = {
            body,
            role: typeof body.participantRole === 'string' ? body.participantRole : seat,
          };
          break;
        }
        lastProblem =
          plainServerText(body.message) ?? plainServerText(body.error) ?? COULD_NOT_JOIN;
        // This visit is tied to one practice meeting. Once it has ended (409) or been unloaded
        // (404), rejoining can never work: offer a fresh practice instead of a dead end.
        if (practice && (body.error === 'practice-ended' || body.error === 'meeting-not-found')) {
          clearStoredJoin(joinVariant);
          setRestore(undefined);
          setRejoinState('idle');
          setRejoinProblem(undefined);
          setRejoinDeadline(undefined);
          setPracticeRestart({
            problem:
              plainServerText(body.message) ??
              'This practice meeting has ended. Start a new practice.',
          });
          return;
        }
        const canTryAnotherSeat =
          realJoin &&
          seats.length > 1 &&
          response.status !== 403 &&
          /seat|place for|pick another role|taken/i.test(lastProblem);
        if (!canTryAnotherSeat) throw new JoinRefused(lastProblem);
      }
      if (joined === undefined) throw new JoinRefused(lastProblem ?? COULD_NOT_JOIN);
      const { body, role: joinedRole } = joined;
      const joiningCode =
        meetingCode ?? (typeof body.meetingCode === 'string' ? body.meetingCode : undefined);
      if (realJoin && realMeetingId !== undefined && joiningCode !== undefined && joiningCode !== '') {
        storeRealMeetingCode(realMeetingId, joiningCode);
      }
      try {
        await refreshScenario();
      } catch {
        // Ignore refresh error if scenario already loaded
      }
      setPane('meeting');
      // The server owns whether the meeting has started: a started (or resumed) meeting goes straight in.
      setStarted(body.started === true || body.resumed === true);
      setSession({
        token: body.token as string,
        serverUrl: typeof body.url === 'string' ? body.url : `ws://${window.location.hostname}:7880`,
        role: joinedRole,
        name,
        media,
        ...(joiningCode === undefined ? {} : { meetingCode: joiningCode }),
      });
      setRestore(undefined);
      setMediaProblem(undefined);
      setRejoinState('idle');
      setRejoinProblem(undefined);
      setRejoinDeadline(undefined);
      storeJoin(joinVariant, {
        name,
        role: joinedRole,
        media,
        ...(joiningCode === undefined ? {} : { meetingCode: joiningCode }),
      });
      if (realJoin && realMeetingId !== undefined) {
        storeRealJoinName(realMeetingId, name);
      }
    } catch (joinError) {
      // Only the sentences this join chose are shown; a network or parsing failure is logged, not printed.
      if (!(joinError instanceof JoinRefused) && !(joinError instanceof TimeoutError)) {
        console.error('kaki web: joining the meeting failed', joinError);
      }
      const message =
        joinError instanceof JoinRefused || joinError instanceof TimeoutError
          ? joinError.message
          : COULD_NOT_JOIN;
      if (reconnecting) {
        setRejoinState('failed');
        setRejoinProblem(message);
      } else {
        setError(message);
      }
    } finally {
      if (!reconnecting) setBusy(false);
    }
  }

  /** Keep the meeting's recoverable state and ask for a fresh token for the same seat. */
  function beginReconnect(target: StoredJoin): void {
    setRestore(target);
    setRejoinState('reconnecting');
    setRejoinProblem(undefined);
    setRejoinDeadline(Date.now() + REJOIN_GRACE_MS);
    setSession(undefined);
    void join(target.name, target.role, target.media, target.meetingCode, { reconnecting: true });
  }

  useEffect(() => {
    if (autoRejoinAttempted.current || restore === undefined) return;
    autoRejoinAttempted.current = true;
    void join(restore.name, restore.role, restore.media, restore.meetingCode, { reconnecting: true });
  }, [restore]);

  if (practiceRestart !== undefined) {
    return (
      <PracticeRestartCard
        meetingTitle={scenario.meetingTitle}
        problem={practiceRestart.problem}
        onNewPractice={onNewPractice}
      />
    );
  }

  if (left && leftSession !== undefined) {
    return (
      <LeftScreen
        meetingTitle={scenario.meetingTitle}
        minutesHref={realMeetingId === undefined ? '#minutes' : `/m/${encodeURIComponent(realMeetingId)}`}
        onRejoin={() => {
          const target = leftSession;
          setLeft(false);
          setLeftSession(undefined);
          setSession(undefined);
          setError(undefined);
          void join(
            target.name,
            target.role,
            target.media,
            target.meetingCode,
            real ? { real: true } : {},
          );
        }}
      />
    );
  }

  if (session === undefined && restore !== undefined) {
    return (
      <RejoinScreen
        meetingTitle={scenario.meetingTitle}
        state={rejoinState}
        problem={rejoinProblem}
        deadline={rejoinDeadline}
        onRejoin={() =>
          void join(restore.name, restore.role, restore.media, restore.meetingCode, { reconnecting: true })
        }
        onLeave={() => {
          clearStoredJoin(joinVariant);
          setRestore(undefined);
          setRejoinState('idle');
          setRejoinProblem(undefined);
          setRejoinDeadline(undefined);
        }}
      />
    );
  }

  if (session === undefined) {
    if (real) {
      const ask =
        effectiveRealName === undefined || effectiveRealName.trim() === ''
          ? 'name'
          : needsCode && error !== undefined
            ? 'code'
            : undefined;
      const submitEntry = (value: string): void => {
        if (ask === 'name') {
          const trimmed = value.trim();
          if (trimmed === '') return;
          setRealNameEntry(trimmed);
          if (realMeetingId !== undefined) storeRealJoinName(realMeetingId, trimmed);
          realAutoAttempted.current = false;
          void join(trimmed, roles[0]?.id ?? '', { microphone: false, camera: false }, effectiveRealCode, {
            real: true,
          });
          return;
        }
        const trimmed = value.trim();
        if (trimmed === '') return;
        setRealCodeEntry(trimmed);
        setNeedsCode(false);
        if (realMeetingId !== undefined) storeRealMeetingCode(realMeetingId, trimmed);
        realAutoAttempted.current = false;
        if (effectiveRealName !== undefined) {
          void join(
            effectiveRealName.trim(),
            roles[0]?.id ?? '',
            { microphone: false, camera: false },
            trimmed,
            { real: true },
          );
        }
      };
      return (
        <RealEntryCard
          title={scenario.meetingTitle}
          ask={ask}
          busy={busy}
          problem={error}
          initialValue={ask === 'name' ? (effectiveRealName ?? '') : (effectiveRealCode ?? '')}
          onSubmit={submitEntry}
          onRetry={() => {
            realAutoAttempted.current = false;
            if (effectiveRealName !== undefined) {
              void join(
                effectiveRealName.trim(),
                roles[0]?.id ?? '',
                { microphone: false, camera: false },
                effectiveRealCode,
                { real: true },
              );
            }
          }}
        />
      );
    }
    if (practice) {
      return (
        <JoinForm
          meetingTitle="Nanyang Kopi (sample workspace)"
          roles={offersSeats ? roles : []}
          agenda={scenario.agenda}
          busy={busy}
          error={offersSeats ? error : seatsError}
          askCode={needsCode}
          initialCode={linkCode}
          toolUrls={scenario.toolUrls}
          meetingId={apiMeetingId}
          onJoin={(name, roleId, media, code) => void join(name, roleId, media, code)}
        />
      );
    }
    return null;
  }

  const seatRole = scenario.roles.find((candidate) => candidate.id === session.role);
  // The meeting is opened by Start, wherever the person sits; a meeting already started goes straight in.
  const needsStart = real ? false : !started;
  // The owner reads the shared screen; a real participant reads their own projection.
  const sharedAudience: 'screen' | 'participant' = real
    ? isHost
      ? 'screen'
      : 'participant'
    : 'screen';

  const roomView = (
    <div className="kd-meeting" data-pane={pane} data-needs-start={needsStart} data-variant={variant}>
      <div className="kd-stage">
        <LiveKitRoom
          video={session.media.camera}
          audio={session.media.microphone}
          connect
          token={session.token}
          serverUrl={session.serverUrl}
          options={ROOM_OPTIONS}
          onDisconnected={(reason) => {
            const target = activeSession.current;
            if (target === undefined) return;
            const outcome = disconnectOutcome(reason);
            if (outcome.kind === 'none') {
              // A deliberate leave must not leave a dead meeting on screen: offer the way back in.
              activeSession.current = undefined;
              setLeftSession(target);
              setLeft(true);
              setSession(undefined);
              return;
            }
            activeSession.current = undefined;
            if (outcome.kind === 'rejoin') {
              beginReconnect(storedFromSession(target));
              return;
            }
            clearStoredJoin(joinVariant);
            setSession(undefined);
            setError(outcome.message);
          }}
          onError={(roomError) => {
            const target = activeSession.current;
            if (target === undefined) return;
            activeSession.current = undefined;
            setRestore(storedFromSession(target));
            setRejoinState('failed');
            console.error(`kaki web: the room connection to ${target.serverUrl} failed`, roomError);
            setRejoinProblem(ROOM_CONNECT_PROBLEM);
            setRejoinDeadline(Date.now() + REJOIN_GRACE_MS);
            setSession(undefined);
          }}
          onMediaDeviceFailure={(failure, kind) => {
            console.error('kaki web: the microphone or camera could not start', failure);
            setMediaProblem(
              practice
                ? failureText('media-blocked', { real: false })
                : kind === 'videoinput'
                  ? failureText('camera-blocked', { real: true })
                  : kind === 'audioinput'
                    ? failureText('mic-blocked', { real: true })
                    : failureText('media-blocked', { real: true }),
            );
          }}
          data-lk-theme="default"
          style={{ height: '100%' }}
        >
          {mediaProblem === undefined || real ? null : (
            <div className="kd-reconnect-banner kd-media-problem" role="alert">
              {mediaProblem}
            </div>
          )}
          <ErrorBoundary>
            <MeetingGrid
              role={session.role}
              sharedAudience={sharedAudience}
              real={real}
              {...(realMeetingId === undefined ? {} : { meetingId: realMeetingId })}
              {...(session.meetingCode === undefined ? {} : { meetingCode: session.meetingCode })}
              onOpenKaki={() => setPane('kaki')}
              onKakiBadgeChange={setKakiBadgeCount}
              {...(mediaProblem === undefined ? {} : { mediaProblem })}
              onMediaProblemCleared={() => setMediaProblem(undefined)}
            />
          </ErrorBoundary>
          <CleanDisconnectOnUnload />
          <LiveConnectionNotice />
          <AudioUnlockPrompt />
          <MeetingLifecycleWatcher onStarted={markMeetingStarted} onReset={markMeetingReset} />
          {needsStart && practice && (
            <ConnectedStartPrompt
              role={seatRole}
              viewerName={session.name}
              seatName={scenario.attendees.find((attendee) => attendee.role === session.role)?.displayName}
              meetingId={apiMeetingId}
              onStarted={() => setStarted(true)}
            />
          )}
        </LiveKitRoom>
      </div>
      <Dock
        meetingId={apiMeetingId}
        meetingCode={session.meetingCode}
        role={seatRole}
        sharedAudience={sharedAudience}
        started={!needsStart}
        practice={practice}
        real={real}
        signedIn={signedIn}
        {...(onNewPractice === undefined ? {} : { onNewPractice })}
        onWingmanBadgeChange={setWingmanBadgeCount}
        viewer={{
          name: session.name,
          seatName: scenario.attendees.find((attendee) => attendee.role === session.role)?.displayName,
          seat: session.role,
        }}
      />
      {real && realMeetingId !== undefined ? <RealEndedOverlay meetingId={realMeetingId} /> : null}
      <nav className="kd-panes" aria-label="Meeting or Kaki">
        <button type="button" aria-pressed={pane === 'meeting'} onClick={() => setPane('meeting')}>
          Meeting
        </button>
        <button type="button" aria-pressed={pane === 'kaki'} onClick={() => setPane('kaki')}>
          Kaki
          {kakiBadgeCount > 0 && pane !== 'kaki' && (
            <span className="kd-pane-badge" aria-label={`${kakiBadgeCount} action item waiting`}>
              {kakiBadgeCount}
            </span>
          )}
          {wingmanBadgeCount > 0 && pane !== 'kaki' && (
            <span
              className="kd-pane-badge kd-pane-badge-wingman"
              aria-label={`${wingmanBadgeCount} private Wingman ${wingmanBadgeCount === 1 ? 'note' : 'notes'}`}
            >
              {wingmanBadgeCount}
            </span>
          )}
        </button>
      </nav>
    </div>
  );

  return (
    <KakiConnectionProvider role={session.role} sharedAudience={sharedAudience}>
      {real && realMeetingId !== undefined ? (
        <RealRoomStateProvider role={session.role} isHost={isHost} meetingId={realMeetingId}>
          {roomView}
        </RealRoomStateProvider>
      ) : (
        roomView
      )}
    </KakiConnectionProvider>
  );
}


/** Shown while LiveKit itself is trying to recover from a network switch or a short screen lock. */
function LiveConnectionNotice() {
  const room = useRoomContext();
  const [state, setState] = useState<ConnectionState | undefined>(room.state);
  useEffect(() => {
    const update = (next: ConnectionState): void => setState(next);
    room.on(RoomEvent.ConnectionStateChanged, update);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, update);
    };
  }, [room]);
  if (state !== ConnectionState.Reconnecting && state !== ConnectionState.SignalReconnecting) {
    return null;
  }
  return (
    <div className="kd-reconnect-banner" role="status">
      Reconnecting…
    </div>
  );
}

/** The way out of a practice whose meeting has ended or been unloaded, without a page reload. */
function PracticeRestartCard({
  meetingTitle,
  problem,
  onNewPractice,
}: {
  meetingTitle: string;
  problem: string;
  onNewPractice?: () => void;
}) {
  return (
    <div className="kd-join" role="region" aria-label="Practice meeting ended">
      <div className="kd-card">
        <div className="kd-live">
          <span className="kd-dot" />
          Practice meeting
        </div>
        <h1 className="kd-title">Your practice meeting is over</h1>
        <p className="kd-sub">{meetingTitle}</p>
        <p className="kd-hint" role="status">
          {problem}
        </p>
        <button type="button" className="kd-go" onClick={onNewPractice} disabled={onNewPractice === undefined}>
          Start a new practice
        </button>
      </div>
    </div>
  );
}

/** The way back into a meeting whose connection dropped, instead of the blank join form. */
function RejoinScreen({
  meetingTitle,
  state,
  problem,
  deadline,
  onRejoin,
  onLeave,
}: {
  meetingTitle: string;
  state: 'idle' | 'reconnecting' | 'failed';
  problem: string | undefined;
  deadline: number | undefined;
  onRejoin(): void;
  onLeave(): void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = deadline === undefined ? undefined : Math.max(0, deadline - now);
  return (
    <div className="kd-join" role="region" aria-label="Reconnecting to the meeting">
      <div className="kd-card">
        <div className="kd-live">
          <span className="kd-dot" />
          {state === 'failed' ? 'Rejoin needed' : 'Reconnecting'}
        </div>
        <h1 className="kd-title">
          {state === 'failed' ? 'Could not get back into the meeting yet' : 'Reconnecting to your meeting…'}
        </h1>
        <p className="kd-sub">{meetingTitle}</p>
        <p className="kd-hint">Same seat and name.</p>
        {remaining === undefined ? null : (
          <p className="kd-hint">
            Your seat is held for about {formatGraceRemaining(remaining)}.
            {remaining === 0 ? ' Rejoining may start a fresh meeting if the hold has ended.' : ''}
          </p>
        )}
        {problem === undefined ? null : (
          <p role="alert" className="kd-alert">
            {problem}
          </p>
        )}
        <button type="button" className="kd-go" onClick={onRejoin} disabled={state === 'reconnecting'}>
          {state === 'reconnecting' ? 'Rejoining…' : 'Rejoin'}
        </button>
        <button type="button" className="kd-chip" onClick={onLeave}>
          Leave and join as someone else
        </button>
      </div>
    </div>
  );
}

/** The way back into a meeting after the person deliberately left it. */
function LeftScreen({
  meetingTitle,
  minutesHref,
  onRejoin,
}: {
  meetingTitle: string;
  minutesHref: string;
  onRejoin(): void;
}) {
  return (
    <div className="kd-join" role="region" aria-label="You left the meeting">
      <div className="kd-card">
        <div className="kd-live">
          <span className="kd-dot" />
          Meeting left
        </div>
        <h1 className="kd-title">You left the meeting</h1>
        <p className="kd-sub">{meetingTitle}</p>
        <p className="kd-hint">Rejoin with the same name and seat, or read what Kaki wrote down.</p>
        <button type="button" className="kd-go" onClick={onRejoin}>
          Rejoin
        </button>
        <a className="kd-go kd-go-secondary" href={minutesHref}>
          See the meeting minutes
        </a>
      </div>
    </div>
  );
}

/** The small entry card a real meeting needs only when the name or invite code is missing. */
function RealEntryCard({
  title,
  ask,
  busy,
  problem,
  initialValue,
  onSubmit,
  onRetry,
}: {
  title: string;
  ask: 'name' | 'code' | undefined;
  busy: boolean;
  problem: string | undefined;
  initialValue: string;
  onSubmit(value: string): void;
  onRetry(): void;
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => setValue(initialValue), [initialValue]);
  return (
    <div className="kd-join">
      <form
        className="kd-card"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          if (ask === undefined || value.trim() === '') return;
          onSubmit(value);
        }}
      >
        <div className="kd-live">
          <span className="kd-dot" />
          Real meeting
        </div>
        <h1 className="kd-title">
          {ask === 'name'
            ? 'What is your name?'
            : ask === 'code'
              ? 'Enter the meeting code'
              : 'Joining the meeting…'}
        </h1>
        <p className="kd-sub">{title}</p>
        {ask === 'code' ? (
          <p className="kd-hint">
            Ask the host for the meeting code, or open the invite link they sent.
          </p>
        ) : null}
        {ask === undefined ? null : (
          <label className="kd-label" style={{ display: 'block', marginBottom: 14 }}>
            {ask === 'name' ? 'Your name' : 'Meeting code'}
            <input
              className="kd-field"
              value={value}
              autoFocus
              maxLength={ask === 'name' ? 40 : 8}
              autoComplete={ask === 'name' ? 'name' : 'off'}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
        )}
        {problem === undefined ? null : (
          <p className="kd-alert" role="alert">
            {problem}
          </p>
        )}
        {ask === undefined ? (
          busy ? null : (
            <button type="button" className="kd-go" onClick={onRetry}>
              Try again
            </button>
          )
        ) : (
          <button type="submit" className="kd-go" disabled={busy || value.trim() === ''}>
            {busy ? 'Joining…' : 'Join the meeting'}
          </button>
        )}
      </form>
    </div>
  );
}
