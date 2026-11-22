import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { LiveKitRoom, useRoomContext } from '@livekit/components-react';
import '@livekit/components-styles';
import { ConnectionState, RoomEvent, type RoomOptions } from 'livekit-client';
import { joinSeatRoles } from '@kaki/shared';
import { useMe } from '../../auth/useMe';
import { meetingApiPath, useKaki, useRefreshScenario, useScenario } from '../../kaki';
import { fetchWithTimeout } from '../../net/withTimeout';
import { ErrorBoundary } from './ErrorBoundary';
import { JoinForm } from './JoinForm';
import type { MediaChoice } from './MediaPreview';
import { MeetingGrid } from './MeetingGrid';
import { Dock } from './Dock';
import { ConnectedStartPrompt } from './StartPrompt';
import { OwnerLobby, WaitingOverlay } from '../MeetingOverlays';
import { TeamJoinForm } from '../TeamJoinForm';
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
import './demo.css';

/** Echo cancellation is what lets the server tell a person talking over the AI from the AI's own playback. */
const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

/** Which journey this page is: the practice demo, a team participant, or the meeting owner. */
type MeetingVariant = 'practice' | 'participant' | 'owner' | 'real';

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
 * The meeting page. Practice keeps the Kopitiam story and its own Start prompt; a team participant
 * waits for the owner; the owner gets the invite lobby. All three share the stage and the Dock.
 */
export default function Meeting({
  variant = 'practice',
  initialCode,
  meetingId,
}: {
  variant?: MeetingVariant;
  initialCode?: string;
  /** A real meeting's row id: its rooms, routes and sockets all live under `/api/meetings/:id`. */
  meetingId?: string;
}) {
  const scenario = useScenario();
  const real = variant === 'real' || meetingId !== undefined;
  const auth = useMe(0, real);
  const refreshScenario = useRefreshScenario();
  // The same seats the server offers: the setup's person seats when it names them, else every
  // human seat and the host's chair when a person can take it.
  const roles = useMemo(() => joinSeatRoles(scenario), [scenario]);
  const practice = variant === 'practice';
  const [session, setSession] = useState<Session | undefined>(() => hotData?.session);
  // A reload must not throw the person back to the name/seat form: remember the join this tab used
  // and ask the server for a fresh token for the same name and seat.
  const initialStored = useRef<StoredJoin | undefined>(
    hotData?.session === undefined ? readStoredJoin(variant) : undefined,
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
  // Cleared as soon as a drop starts a rejoin, so an unmount cannot start a second join for the same room.
  const activeSession = useRef<Session | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [realInProgress, setRealInProgress] = useState(false);
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
    }
  }, [session, pane, started]);

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
      setRealInProgress(false);
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
          realJoin && realMeetingId !== undefined
            ? meetingApiPath(realMeetingId, '/api/livekit/token')
            : '/api/livekit/token',
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
        if (body.realInProgress === true) setRealInProgress(true);
        if (response.ok && typeof body.token === 'string') {
          joined = {
            body,
            role: typeof body.participantRole === 'string' ? body.participantRole : seat,
          };
          break;
        }
        lastProblem =
          typeof body.message === 'string' && body.message.trim() !== ''
            ? body.message
            : typeof body.error === 'string'
              ? body.error
              : `Could not join (HTTP ${response.status}).`;
        const canTryAnotherSeat =
          realJoin &&
          seats.length > 1 &&
          response.status !== 403 &&
          /seat|place for|pick another role|taken/i.test(lastProblem);
        if (!canTryAnotherSeat) throw new Error(lastProblem);
      }
      if (joined === undefined) throw new Error(lastProblem ?? 'Could not join this meeting.');
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
      setRejoinState('idle');
      setRejoinProblem(undefined);
      setRejoinDeadline(undefined);
      storeJoin(variant, {
        name,
        role: joinedRole,
        media,
        ...(joiningCode === undefined ? {} : { meetingCode: joiningCode }),
      });
      if (realJoin && realMeetingId !== undefined) {
        storeRealJoinName(realMeetingId, name);
      }
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : String(joinError);
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

  if (left && leftSession !== undefined) {
    return (
      <LeftScreen
        meetingTitle={scenario.meetingTitle}
        minutesHref={realMeetingId === undefined ? '#minutes' : `/m/${encodeURIComponent(realMeetingId)}/room#minutes`}
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
          clearStoredJoin(variant);
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
          meetingTitle={scenario.meetingTitle}
          roles={offersSeats ? roles : []}
          agenda={scenario.agenda}
          busy={busy}
          error={offersSeats ? error : seatsError}
          askCode={needsCode}
          initialCode={linkCode}
          errorAction={
            realInProgress ? (
              <p className="kd-hint">
                <Link to="/">Back to Kaki</Link>
              </p>
            ) : undefined
          }
          onJoin={(name, roleId, media, code) => void join(name, roleId, media, code)}
        />
      );
    }
    return (
      <TeamJoinForm
        meetingTitle={scenario.meetingTitle}
        roles={offersSeats ? roles : []}
        busy={busy}
        error={offersSeats ? error : seatsError}
        initialCode={linkCode}
        owner={variant === 'owner'}
        onJoin={(name, roleId, media, code) => void join(name, roleId, media, code)}
      />
    );
  }

  const seatRole = scenario.roles.find((candidate) => candidate.id === session.role);
  // The meeting is opened by Start, wherever the person sits; a meeting already started goes straight in.
  const needsStart = real ? false : !started;
  // The owner reads the shared screen; a real participant reads their own projection.
  const sharedAudience: 'screen' | 'participant' = real
    ? isHost
      ? 'screen'
      : 'participant'
    : variant === 'participant'
      ? 'participant'
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
            clearStoredJoin(variant);
            setSession(undefined);
            setError(outcome.message);
          }}
          onError={(roomError) => {
            const target = activeSession.current;
            if (target === undefined) return;
            activeSession.current = undefined;
            setRestore(storedFromSession(target));
            setRejoinState('failed');
            setRejoinProblem(
              `Could not reach the meeting server at ${target.serverUrl}: ${roomError.message}. Is LiveKit running (npm run stack:up)?`,
            );
            setRejoinDeadline(Date.now() + REJOIN_GRACE_MS);
            setSession(undefined);
          }}
          data-lk-theme="default"
          style={{ height: '100%' }}
        >
          <ErrorBoundary>
            <MeetingGrid
              role={session.role}
              sharedAudience={sharedAudience}
              real={real}
              {...(realMeetingId === undefined ? {} : { meetingId: realMeetingId })}
              {...(session.meetingCode === undefined ? {} : { meetingCode: session.meetingCode })}
              viewerName={session.name}
              onOpenKaki={() => setPane('kaki')}
              onKakiBadgeChange={setKakiBadgeCount}
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
              onStarted={() => setStarted(true)}
            />
          )}
          {needsStart && variant === 'participant' && (
            <WaitingOverlay meetingTitle={scenario.meetingTitle} />
          )}
          {needsStart && variant === 'owner' && (
            <OwnerLobby initialCode={session.meetingCode} onStarted={markMeetingStarted} />
          )}
        </LiveKitRoom>
      </div>
      <Dock
        meetingCode={session.meetingCode}
        role={seatRole}
        sharedAudience={sharedAudience}
        started={!needsStart}
        practice={practice}
        real={real}
        onWingmanBadgeChange={setWingmanBadgeCount}
        viewer={{
          name: session.name,
          seatName: scenario.attendees.find((attendee) => attendee.role === session.role)?.displayName,
        }}
      />
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

  return real && realMeetingId !== undefined ? (
    <RealRoomStateProvider role={session.role} isHost={isHost}>
      {roomView}
    </RealRoomStateProvider>
  ) : (
    roomView
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
        <p className="kd-hint">
          <a href={minutesHref}>See the meeting minutes</a>
        </p>
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
