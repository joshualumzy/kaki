import { useMemo, useState } from 'react';
import { LiveKitRoom } from '@livekit/components-react';
import '@livekit/components-styles';
import type { RoomOptions } from 'livekit-client';
import { demoRoomName, humanAttendeeForRole, humanRoles } from '@kaki/shared';
import { useScenario } from '../kaki';
import { PhoneFeed } from '../phone/PhonePage';
import { ErrorBoundary } from './ErrorBoundary';
import { JoinForm } from './JoinForm';
import { LocalSpeechSTT } from './LocalSpeechSTT';
import { MeetingGrid } from './MeetingGrid';
import { RoleCard } from './RoleCard';

/** Echo cancellation is what lets the server tell a person talking over the AI from the AI's own playback. */
const ROOM_OPTIONS: RoomOptions = {
  audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

interface Session {
  token: string;
  serverUrl: string;
  /** The Kaki role id of the attendee this person plays, for their private feed. */
  role: string;
}

/** Ask for the microphone up front, so a refusal is explained before joining, and release it again. */
async function checkMicrophone(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotFoundError') throw new Error('No microphone was found.');
    throw new Error('Microphone permission is required to join the meeting.');
  }
}

/** The live demo meeting: join with a name and role, then talk to the AI attendees. */
export default function Meeting() {
  const scenario = useScenario();
  const roles = useMemo(() => humanRoles(scenario), [scenario]);
  const [session, setSession] = useState<Session | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const hasAi = (scenario.npcs ?? []).length > 0;

  async function join(name: string, roleLabel: string): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await checkMicrophone();
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
        onJoin={(name, roleLabel) => void join(name, roleLabel)}
      />
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, backgroundColor: '#000', position: 'relative', minWidth: 0 }}>
        <LiveKitRoom
          video={false}
          audio
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
      <div style={{ width: '400px', backgroundColor: '#f9fafb', borderLeft: '1px solid #e5e7eb', overflowY: 'auto' }}>
        <RoleCard role={scenario.roles.find((candidate) => candidate.id === session.role)} />
        <ErrorBoundary>
          <PhoneFeed role={session.role} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
