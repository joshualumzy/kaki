import React, { useEffect, useState } from 'react';
import { useTracks, GridLayout, ParticipantTile, RoomAudioRenderer, ControlBar, useTrackRefContext } from '@livekit/components-react';
import { Track } from 'livekit-client';
import { useKaki } from '../kaki';

export function CaptionedTile() {
  const trackRef = useTrackRefContext();
  const participant = trackRef?.participant;
  const { events } = useKaki('producer');
  
  // Force re-evaluation every second so old transcripts expire
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const latestTranscript = React.useMemo(() => {
    if (!participant) return null;
    const chunks = events.filter((e): e is Extract<typeof e, { type: 'TRANSCRIPT_CHUNK' }> => e.type === 'TRANSCRIPT_CHUNK');
    const relevant = chunks.filter(c => {
      const pName = participant.identity || participant.name || '';
      // Only show transcripts belonging to this specific tile's participant
      const isNPC = pName === 'Arjun' || pName === 'Maya';
      return c.payload.speaker === pName || c.payload.speaker === pName + ' [INTERIM]' || (pName.includes(c.payload.speaker) && c.payload.speaker.length > 0) || (isNPC && c.payload.speaker === 'System');
    });
    
    if (relevant.length === 0) return null;
    const latest = relevant[relevant.length - 1];
    
    // Hide transcripts older than 15 seconds
    const transcriptTime = new Date(latest.payload.timestamp).getTime();
    if (now - transcriptTime > 15000) {
      return null;
    }
    
    return latest;
  }, [events, participant?.identity, participant?.name, now]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ParticipantTile style={{ width: '100%', height: '100%' }} />
      {latestTranscript && latestTranscript.payload.text.trim().length > 0 && (
        <div style={{
          position: 'absolute',
          bottom: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          width: '90%',
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
          color: 'white',
          padding: '8px 12px',
          borderRadius: '8px',
          fontSize: '16px',
          lineHeight: 1.4,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          textShadow: '1px 1px 2px rgba(0,0,0,0.8)',
          textAlign: 'center',
          pointerEvents: 'none'
        }}>
          {latestTranscript.payload.text === '💭 Thinking...' ? (
            <span style={{ display: 'inline-block', animation: 'kaki-pulse 1.5s infinite ease-in-out' }}>
              💭 Thinking...
            </span>
          ) : (
            latestTranscript.payload.text
          )}
        </div>
      )}
      <style>
        {`
          @keyframes kaki-pulse {
            0% { opacity: 0.4; }
            50% { opacity: 1; }
            100% { opacity: 0.4; }
          }
        `}
      </style>
    </div>
  );
}

export function MeetingGrid() {
  const cameraTracks = useTracks([ { source: Track.Source.Camera, withPlaceholder: true } ], { onlySubscribed: false });
  const screenTracks = useTracks([ { source: Track.Source.ScreenShare, withPlaceholder: false } ], { onlySubscribed: false });
  const micTracks = useTracks([ { source: Track.Source.Microphone, withPlaceholder: true } ], { onlySubscribed: false });
  
  const tracks = React.useMemo(() => {
    const unique = new Map();
    // Prefer camera tracks as base tiles
    for (const t of cameraTracks) {
       unique.set(t.participant.identity, t);
    }
    // If a participant only has mic, add them
    for (const t of micTracks) {
       if (!unique.has(t.participant.identity)) {
         unique.set(t.participant.identity, t);
       }
    }
    const baseTiles = Array.from(unique.values());
    return [...baseTiles, ...screenTracks];
  }, [cameraTracks, screenTracks, micTracks]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, padding: '10px' }}>
        {tracks.length === 0 ? (
           <div style={{ color: 'white', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
             Waiting for participants...
           </div>
        ) : (
           <GridLayout tracks={tracks} style={{ height: '100%' }}>
             <CaptionedTile />
           </GridLayout>
        )}
      </div>
      <ControlBar />
      <RoomAudioRenderer />
    </div>
  );
}
