import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useDataChannel,
  useParticipants,
  useTrackRefContext,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { NPC_STATE_TOPIC, type NpcStateMessage, type Scenario } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { ConnectedTypeBar } from './TypeBar';
import { captionFor, transcriptChunks, transcriptNameFor, type TranscriptChunk } from './captions';

interface Stage {
  scenario: Scenario;
  chunks: TranscriptChunk[];
  now: number;
  npcState: NpcStateMessage;
}

const StageContext = createContext<Stage | null>(null);

function useStage(): Stage {
  const stage = useContext(StageContext);
  if (stage === null) throw new Error('useStage must be used inside MeetingGrid');
  return stage;
}

const overlay = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  width: '90%',
  backgroundColor: 'rgba(0, 0, 0, 0.7)',
  color: 'white',
  padding: '8px 12px',
  borderRadius: '8px',
  textAlign: 'center',
  pointerEvents: 'none',
  fontFamily: 'system-ui, -apple-system, sans-serif',
} as const;

function CaptionedTile() {
  const { scenario, chunks, now, npcState } = useStage();
  const participant = useTrackRefContext().participant;
  const isAi = (scenario.npcs ?? []).some((npc) => npc.attendee === participant.identity);
  const caption = captionFor(chunks, transcriptNameFor(scenario, participant), now);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ParticipantTile style={{ width: '100%', height: '100%' }} />
      {caption !== null ? (
        <div style={{ ...overlay, bottom: '16px', fontSize: '16px', lineHeight: 1.4 }}>{caption}</div>
      ) : (
        isAi &&
        npcState.kind === 'thinking' && (
          <div style={{ ...overlay, bottom: '16px', fontSize: '14px', animation: 'kaki-pulse 1.5s infinite ease-in-out' }}>
            💭 Thinking…
          </div>
        )
      )}
    </div>
  );
}

/** The meeting stage: one tile per participant with live captions, and the AI attendees' status. */
export function MeetingGrid({ role }: { role: string }) {
  const scenario = useScenario();
  const { events } = useKaki(role);
  const participants = useParticipants();
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  // Captions fade by the clock, so the stage re-renders twice a second.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(interval);
  }, []);

  const [npcState, setNpcState] = useState<NpcStateMessage>({ kind: 'idle' });
  useDataChannel(NPC_STATE_TOPIC, (message) => {
    try {
      setNpcState(JSON.parse(new TextDecoder().decode(message.payload)) as NpcStateMessage);
    } catch {
      // not a message from the AI attendees
    }
  });

  const aiNames = useMemo(() => new Set((scenario.npcs ?? []).map((npc) => npc.attendee)), [scenario]);
  const aiPresent = participants.some((participant) => aiNames.has(participant.identity));
  const stage = useMemo(
    () => ({ scenario, chunks: transcriptChunks(events), now, npcState }),
    [scenario, events, now, npcState],
  );

  return (
    <StageContext.Provider value={stage}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
        {npcState.kind === 'error' && (
          <div role="alert" style={{ ...overlay, top: '10px', backgroundColor: 'rgba(153,27,27,0.9)', zIndex: 2 }}>
            The AI attendees hit a problem: {npcState.message}
          </div>
        )}
        {!aiPresent && (
          <div style={{ ...overlay, top: '10px', fontSize: '14px', zIndex: 1 }}>
            Waiting for the AI attendees. Start them with <code>npm run npc</code>.
          </div>
        )}
        <div style={{ flex: 1, padding: '10px', minHeight: 0 }}>
          <GridLayout tracks={tracks} style={{ height: '100%' }}>
            <CaptionedTile />
          </GridLayout>
        </div>
        <ConnectedTypeBar />
        <ControlBar controls={{ screenShare: false, chat: false }} />
        <RoomAudioRenderer />
        <style>{'@keyframes kaki-pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }'}</style>
      </div>
    </StageContext.Provider>
  );
}
