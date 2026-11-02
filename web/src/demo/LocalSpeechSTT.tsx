import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { STT_TOPIC, type SttMessage } from '@kaki/shared';
import { browserRecognitionWanted, speechRecognitionCtor, startRecognizer } from './speech';

const chip: CSSProperties = {
  position: 'absolute',
  top: '10px',
  right: '10px',
  background: 'rgba(0,0,0,0.6)',
  color: 'white',
  padding: '4px 8px',
  borderRadius: '4px',
  fontSize: '12px',
  maxWidth: '60%',
  pointerEvents: 'none',
};

/** Singapore English by default, which hears local accents better than US English; `/demo?lang=en-US` overrides it. */
function recognitionLanguage(): string {
  try {
    return new URLSearchParams(window.location.search).get('lang') || 'en-SG';
  } catch {
    return 'en-SG';
  }
}

/**
 * Turns the person's speech into text with the browser's own recognition and sends each finished
 * piece to the AI attendees over LiveKit. It sends everything it hears: whether that is the
 * person or the AI's own voice coming back through the speakers is decided on the server, which
 * can see the echo-cancelled microphone track and this page cannot.
 */
export function LocalSpeechSTT() {
  const room = useRoomContext();
  const { isMicrophoneEnabled } = useLocalParticipant();
  const wanted = useMemo(() => browserRecognitionWanted(window.location.search), []);
  const Recognition = useMemo(() => (wanted ? speechRecognitionCtor() : undefined), [wanted]);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    if (Recognition === undefined || !isMicrophoneEnabled) return;
    setProblem(undefined);
    const encoder = new TextEncoder();
    return startRecognizer(
      Recognition,
      {
      onFinal: (text) => {
        const message: SttMessage = { text };
        room.localParticipant
          .publishData(encoder.encode(JSON.stringify(message)), { reliable: true, topic: STT_TOPIC })
          .catch(() => setProblem('Could not send your words to the meeting.'));
      },
      onInterim: setInterim,
      onListening: setListening,
      onFatal: setProblem,
    },
      { lang: recognitionLanguage() },
    );
  }, [Recognition, isMicrophoneEnabled, room]);

  if (!wanted) {
    return <div style={chip}>{isMicrophoneEnabled ? '🎙️ The meeting server is listening' : 'Microphone muted: the AI cannot hear you.'}</div>;
  }
  if (Recognition === undefined) {
    return <div style={chip}>Speech recognition needs Chrome or Edge: the AI cannot hear you in this browser.</div>;
  }
  if (problem !== undefined) return <div style={{ ...chip, background: 'rgba(153,27,27,0.85)' }}>{problem}</div>;
  if (!isMicrophoneEnabled) return <div style={chip}>Microphone muted: the AI cannot hear you.</div>;

  return (
    <>
      <div style={chip}>{listening ? '🎙️ Listening' : 'Starting speech recognition…'}</div>
      {interim.length > 0 && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: '80px',
            transform: 'translateX(-50%)',
            maxWidth: '70%',
            background: 'rgba(30,64,175,0.8)',
            color: 'white',
            padding: '6px 12px',
            borderRadius: '8px',
            fontSize: '15px',
            fontStyle: 'italic',
            pointerEvents: 'none',
          }}
        >
          {interim}
        </div>
      )}
    </>
  );
}
