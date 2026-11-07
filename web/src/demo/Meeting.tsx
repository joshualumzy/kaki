import { useMemo, useState } from 'react';
import { LiveKitRoom } from '@livekit/components-react';
import '@livekit/components-styles';
import type { RoomOptions } from 'livekit-client';
import { demoRoomName, hostRole, humanAttendeeForRole, humanRoles } from '@kaki/shared';
import { useRefreshScenario, useScenario } from '../kaki';
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

/** The live demo meeting: join with a name and role, then talk to the AI attendees. */
export default function Meeting() {
  const scenario = useScenario();
  const refreshScenario = useRefreshScenario();
  // Participants first; the host's seat last, when the scenario lets a person run the meeting.
  const roles = useMemo(() => {
    const host = hostRole(scenario);
    return host === undefined ? humanRoles(scenario) : [...humanRoles(scenario), host];
  }, [scenario]);
  const [session, setSession] = useState<Session | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [needsCode, setNeedsCode] = useState(false);
  const [pane, setPane] = useState<'meeting' | 'kaki'>('meeting');
  // The AI attendees stay silent until the person has read their briefing and pressed Start.
  const [started, setStarted] = useState(false);
  const linkCode = useMemo(() => new URLSearchParams(window.location.search).get('code') ?? '', []);

  const hasAi = (scenario.npcs ?? []).length > 0;

  async function join(name: string, roleLabel: string, media: MediaChoice, meetingCode?: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: demoRoomName(scenario), participantName: name, participantRole: roleLabel, ...(meetingCode === undefined || meetingCode === '' ? {} : { meetingCode }) }),
      });
      const body = (await response.json().catch(() => ({}))) as { token?: unknown; url?: unknown; error?: unknown; needsCode?: unknown; meetingCode?: unknown };
      if (body.needsCode === true) setNeedsCode(true);
      if (!response.ok || typeof body.token !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : `Could not join (HTTP ${response.status}).`);
      }
      await refreshScenario().catch(() => undefined);
      setSession({
        token: body.token,
        serverUrl: typeof body.url === 'string' ? body.url : `ws://${window.location.hostname}:7880`,
        role: humanAttendeeForRole(scenario, roleLabel)?.role ?? roles[0]?.id ?? scenario.roles[0]?.id ?? '',
        name,
        media,
        ...(typeof body.meetingCode === 'string' ? { meetingCode: body.meetingCode } : {}),
      });
      setPane('meeting');
      setStarted(false);
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
        roles={hasAi ? roles : []}
        busy={busy}
        error={hasAi ? error : `${scenario.id} has no AI attendees: add "npcs" to its scenario.json.`}
        askCode={needsCode}
        initialCode={linkCode}
        onJoin={(name, roleLabel, media, code) => void join(name, roleLabel, media, code)}
      />
    );
  }

  const seatRole = scenario.roles.find((candidate) => candidate.id === session.role);
  // Whoever runs the meeting opens it themselves, so only the other roles get the Start button.
  const needsStart = !started && seatRole?.facilitator !== true;

  return (
    <div className="kd-meeting" data-pane={pane}>
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
            <MeetingGrid role={session.role} />
          </ErrorBoundary>
          <LocalSpeechSTT />
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
        </button>
      </nav>
    </div>
  );
}
