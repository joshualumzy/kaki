import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { STT_TOPIC, type SttMessage } from '@kaki/shared';
import { browserRecognitionWanted, speechRecognitionCtor, startRecognizer } from './speech';

const chip: CSSProperties = {
  position: 'absolute',
  bottom: '108px',
  right: '14px',
  background: 'rgba(13, 17, 23, 0.72)',
  backdropFilter: 'blur(8px)',
  color: 'white',
  padding: '4px 10px',
  borderRadius: '999px',
  fontSize: '11.5px',
  maxWidth: '60%',
  pointerEvents: 'none',
  zIndex: 4,
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
export function LocalSpeechSTT({ onSpeechLine }: { onSpeechLine?(text: string): void } = {}) {
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
        // The server records the line from this socket, so it survives with no AI runner connected.
        onSpeechLine?.(text);
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
  }, [Recognition, isMicrophoneEnabled, room, onSpeechLine]);

  if (!wanted) {
    return null;
  }
  if (Recognition === undefined) {
    return <div style={chip}>Speech recognition needs Chrome or Edge: the AI cannot hear you in this browser.</div>;
  }
  if (problem !== undefined) return <div style={{ ...chip, background: 'rgba(153,27,27,0.85)' }}>{problem}</div>;
  if (!isMicrophoneEnabled) return null;

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
