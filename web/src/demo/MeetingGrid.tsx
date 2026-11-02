import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  ControlBar,
  GridLayout,
  ParticipantTile,
  RoomAudioRenderer,
  useDataChannel,
  useIsSpeaking,
  useParticipants,
  useTrackRefContext,
  useTracks,
} from '@livekit/components-react';
import { Track } from 'livekit-client';
import { NPC_STATE_TOPIC, type NpcStateMessage, type Scenario } from '@kaki/shared';
import { useKaki, useScenario } from '../kaki';
import { ConnectedTypeBar } from './TypeBar';
import { Orb, orbPalette } from './Orb';
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

function CaptionedTile() {
  const { scenario, chunks, now, npcState } = useStage();
  const participant = useTrackRefContext().participant;
  const aiIndex = (scenario.npcs ?? []).findIndex((npc) => npc.attendee === participant.identity);
  const isAi = aiIndex >= 0;
  const humanSpeaking = useIsSpeaking(participant);
  const caption = captionFor(chunks, transcriptNameFor(scenario, participant), now);
  const speaking = isAi ? npcState.kind === 'speaking' && npcState.speaker === participant.identity : humanSpeaking;
  const thinking = isAi && npcState.kind === 'thinking';
  const state = speaking ? 'speaking' : thinking ? 'thinking' : 'idle';

  return (
    <div className="kd-tile" data-state={state} data-ai={isAi} style={{ ['--c' as string]: `var(${orbPalette(isAi ? aiIndex : 1)[0]})` }}>
      {isAi ? <Orb state={state} palette={orbPalette(aiIndex)} /> : <ParticipantTile style={{ width: '100%', height: '100%' }} />}
      {isAi && (
        <>
          <div className="kd-who">
            <i />
            {participant.identity}
          </div>
          <div className="kd-state">{state}</div>
        </>
      )}
      {caption !== null && <div className="kd-caption">{caption}</div>}
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
          <div role="alert" className="kd-banner" data-tone="error">
            The AI attendees hit a problem: {npcState.message}
          </div>
        )}
        {!aiPresent && (
          <div className="kd-banner">
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
      </div>
    </StageContext.Provider>
  );
}
