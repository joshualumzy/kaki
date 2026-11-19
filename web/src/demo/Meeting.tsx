import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveKitRoom, useRoomContext } from '@livekit/components-react';
import '@livekit/components-styles';
import type { RoomOptions } from 'livekit-client';
import { demoRoomName, hostRole, humanAttendeeForRole, humanRoles } from '@kaki/shared';
import { useKaki, useRefreshScenario, useScenario } from '../kaki';
import { ErrorBoundary } from './ErrorBoundary';
import { JoinForm } from './JoinForm';
import { LocalSpeechSTT } from './LocalSpeechSTT';
import type { MediaChoice } from './MediaPreview';
import { MeetingGrid } from './MeetingGrid';
import { Dock } from './Dock';
import { ConnectedStartPrompt } from './StartPrompt';
import './demo.css';

/** Echo cancellation is what lets the server tell a person talking over the AI from the AI's own playback. */
const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

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
  const { started } = useKaki('lifecycle');
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

/** The live demo meeting: join with a name and role, then talk to the AI attendees. */
export default function Meeting() {
  const scenario = useScenario();
  const refreshScenario = useRefreshScenario();
  // Participants first; the host's seat last, when the scenario lets a person run the meeting.
  // When the owner set the seats, only the setup's person seats are offered.
  const roles = useMemo(() => {
    const host = hostRole(scenario);
    const seats = host === undefined ? humanRoles(scenario) : [...humanRoles(scenario), host];
    if (scenario.joinSeats === undefined) return seats;
    const allowed = new Set(scenario.joinSeats);
    const offered = seats.filter((role) => allowed.has(role.id));
    // humanRoles hides a facilitator's chair; the setup may still name it as a person seat. Only
    // offer a seat the server would admit, so never append a role that has nobody to play it.
    for (const id of scenario.joinSeats) {
      if (offered.some((role) => role.id === id)) continue;
      const role = scenario.roles.find((candidate) => candidate.id === id);
      if (role === undefined) continue;
      if (!scenario.attendees.some((attendee) => attendee.role === id)) continue;
      offered.push(role);
    }
    return offered;
  }, [scenario]);
  const [session, setSession] = useState<Session | undefined>(() => hotData?.session);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [needsCode, setNeedsCode] = useState(false);
  const [pane, setPane] = useState<'meeting' | 'kaki'>(() => hotData?.pane ?? 'meeting');
  const [kakiBadgeCount, setKakiBadgeCount] = useState(0);
  // The AI attendees stay silent until the person has read their briefing and pressed Start.
  const [started, setStarted] = useState<boolean>(() => hotData?.started ?? false);
  useEffect(() => {
    if (hotData !== undefined) {
      hotData.session = session;
      hotData.pane = pane;
      hotData.started = started;
    }
  }, [session, pane, started]);
  const linkCode = useMemo(() => new URLSearchParams(window.location.search).get('code') ?? '', []);
  const markMeetingStarted = useCallback(() => setStarted(true), []);
  const markMeetingReset = useCallback(() => setStarted(false), []);

  const hasAi = (scenario.npcs ?? []).length > 0;
  // A human-only setup names its person seats; those are the seats to offer even with no AI cast.
  const offersSeats = hasAi || scenario.joinSeats !== undefined;

  async function join(name: string, roleLabel: string, media: MediaChoice, meetingCode?: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: demoRoomName(scenario), participantName: name, participantRole: roleLabel, ...(meetingCode === undefined || meetingCode === '' ? {} : { meetingCode }) }),
      });
      const body = (await response.json().catch(() => ({}))) as { token?: unknown; url?: unknown; error?: unknown; needsCode?: unknown; meetingCode?: unknown; resumed?: unknown; started?: unknown };
      if (body.needsCode === true) setNeedsCode(true);
      if (!response.ok || typeof body.token !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : `Could not join (HTTP ${response.status}).`);
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
        token: body.token,
        serverUrl: typeof body.url === 'string' ? body.url : `ws://${window.location.hostname}:7880`,
        role: humanAttendeeForRole(scenario, roleLabel)?.role ?? roles[0]?.id ?? scenario.roles[0]?.id ?? '',
        name,
        media,
        ...(typeof body.meetingCode === 'string' ? { meetingCode: body.meetingCode } : {}),
      });
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : String(joinError));
    } finally {
      setBusy(false);
    }
  }

  if (session === undefined) {
    return (
      <JoinForm
        meetingTitle={scenario.meetingTitle}
        roles={offersSeats ? roles : []}
        agenda={scenario.agenda}
        busy={busy}
        error={offersSeats ? error : `${scenario.id} has no AI attendees: add "npcs" to its scenario.json.`}
        askCode={needsCode}
        initialCode={linkCode}
        onJoin={(name, roleLabel, media, code) => void join(name, roleLabel, media, code)}
      />
    );
  }

  const seatRole = scenario.roles.find((candidate) => candidate.id === session.role);
  // The meeting is opened by Start, wherever the person sits; a meeting already started goes straight in.
  const needsStart = !started;

  return (
    <div className="kd-meeting" data-pane={pane} data-needs-start={needsStart}>
      <div className="kd-stage">
        <LiveKitRoom
          video={session.media.camera}
          audio={session.media.microphone}
          connect
          token={session.token}
          serverUrl={session.serverUrl}
          options={ROOM_OPTIONS}
          onDisconnected={() => setSession(undefined)}
          onError={(roomError) => {
            setError(`Could not reach the meeting server at ${session.serverUrl}: ${roomError.message}. Is LiveKit running (npm run stack:up)?`);
            setSession(undefined);
          }}
          data-lk-theme="default"
          style={{ height: '100%' }}
        >
          <ErrorBoundary>
            <MeetingGrid
              role={session.role}
              onOpenKaki={() => setPane('kaki')}
              onKakiBadgeChange={setKakiBadgeCount}
            />
          </ErrorBoundary>
          <LocalSpeechSTT />
          <CleanDisconnectOnUnload />
          <MeetingLifecycleWatcher onStarted={markMeetingStarted} onReset={markMeetingReset} />
          {needsStart && (
            <ConnectedStartPrompt
              role={seatRole}
              viewerName={session.name}
              seatName={scenario.attendees.find((attendee) => attendee.role === session.role)?.zoomDisplayName}
              onStarted={() => setStarted(true)}
            />
          )}
        </LiveKitRoom>
      </div>
      <Dock
        meetingCode={session.meetingCode}
        role={seatRole}
        started={!needsStart}
        viewer={{
          name: session.name,
          seatName: scenario.attendees.find((attendee) => attendee.role === session.role)?.zoomDisplayName,
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
        </button>
      </nav>
    </div>
  );
}
