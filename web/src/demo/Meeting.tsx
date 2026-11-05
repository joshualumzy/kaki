import { useMemo, useState } from 'react';
import { LiveKitRoom } from '@livekit/components-react';
import '@livekit/components-styles';
import type { RoomOptions } from 'livekit-client';
import { demoRoomName, humanAttendeeForRole, humanRoles } from '@kaki/shared';
import { useScenario } from '../kaki';
import { ErrorBoundary } from './ErrorBoundary';
import { JoinForm } from './JoinForm';
import { LocalSpeechSTT } from './LocalSpeechSTT';
import type { MediaChoice } from './MediaPreview';
import { MeetingGrid } from './MeetingGrid';
import { Dock } from './Dock';
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
}

/** The live demo meeting: join with a name and role, then talk to the AI attendees. */
export default function Meeting() {
  const scenario = useScenario();
  const roles = useMemo(() => humanRoles(scenario), [scenario]);
  const [session, setSession] = useState<Session | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const hasAi = (scenario.npcs ?? []).length > 0;

  async function join(name: string, roleLabel: string, media: MediaChoice): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomName: demoRoomName(scenario), participantName: name, participantRole: roleLabel }),
      });
      const body = (await response.json().catch(() => ({}))) as { token?: unknown; url?: unknown; error?: unknown };
      if (!response.ok || typeof body.token !== 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : `Could not join (HTTP ${response.status}).`);
      }
      setSession({
        token: body.token,
        serverUrl: typeof body.url === 'string' ? body.url : `ws://${window.location.hostname}:7880`,
        role: humanAttendeeForRole(scenario, roleLabel)?.role ?? roles[0]?.id ?? scenario.roles[0]?.id ?? '',
        name,
        media,
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
        roles={hasAi ? roles : []}
        busy={busy}
        error={hasAi ? error : `${scenario.id} has no AI attendees: add "npcs" to its scenario.json.`}
        onJoin={(name, roleLabel, media) => void join(name, roleLabel, media)}
      />
    );
  }

  return (
    <div className="kd-meeting">
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
        </LiveKitRoom>
      </div>
      <Dock
        role={scenario.roles.find((candidate) => candidate.id === session.role)}
        viewer={{
          name: session.name,
          seatName: scenario.attendees.find((attendee) => attendee.role === session.role)?.zoomDisplayName,
        }}
      />
    </div>
  );
}
