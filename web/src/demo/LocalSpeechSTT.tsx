
import { useEffect, useState, useRef } from 'react';
import { useLocalParticipant, useParticipants } from '@livekit/components-react';
import { useKaki } from '../kaki';

export function LocalSpeechSTT({ participantName }: { participantName: string }) {
  const [isListening, setIsListening] = useState(false);
  const { isMicrophoneEnabled } = useLocalParticipant();
  const participants = useParticipants();
  const { events } = useKaki('producer');
  
  // Track the absolute full transcript length to diff against
  const lastAiSpeechTime = useRef<number>(0);
  
  // Create a ref for participants so the recognition callback can access the latest state without re-rendering the recognition
  const participantsRef = useRef(participants);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Update lastAiSpeechTime when Arjun or Maya emits a transcript
  useEffect(() => {
    if (events.length === 0) return;
    const lastEvent = events[events.length - 1];
    if (lastEvent.type === 'TRANSCRIPT_CHUNK') {
       const speaker = lastEvent.payload.speaker;
       if (speaker.startsWith('Arjun') || speaker.startsWith('Maya')) {
          lastAiSpeechTime.current = Date.now();
       }
    }
  }, [events]);

  useEffect(() => {
    if (!isMicrophoneEnabled) return;
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => {
      setIsListening(false);
      previousFinal = "";
      previousInterim = "";
      setTimeout(() => { try { recognition.start(); } catch(e){} }, 100);
    };

    let previousInterim = "";
    let previousFinal = "";

    recognition.onresult = (event: any) => {
      // Acoustic Feedback Blocker: 
      // If AI spoke within the last 4000ms OR is currently speaking according to LiveKit audio levels, 
      // ignore this transcription entirely to prevent the mic from picking up the AI's speakers.
      const isAiSpeakingAudio = participantsRef.current.some(p => 
        (p.identity === 'Arjun' || p.identity === 'Maya') && p.isSpeaking
      );
      
      if (isAiSpeakingAudio || Date.now() - lastAiSpeechTime.current < 4000) {
        // Drop the transcription but keep previousFinal length in sync
        let fullStr = "";
        for (let i = 0; i < event.results.length; ++i) {
           fullStr += event.results[i][0].transcript;
        }
        previousFinal = fullStr.trim();
        previousInterim = "";
        return;
      }

      let currentFinal = "";
      let currentInterim = "";
      
      // Always rebuild the entire string from index 0 to avoid browser inconsistencies
      for (let i = 0; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          currentFinal += event.results[i][0].transcript;
        } else {
          currentInterim += event.results[i][0].transcript;
        }
      }
      
      const finalStr = currentFinal.trim();
      const interimStr = currentInterim.trim();

      // Emit interim diff
      if (interimStr && interimStr !== previousInterim) {
        previousInterim = interimStr;
        fetch('/dev/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'TRANSCRIPT_CHUNK',
            payload: { speaker: participantName + ' [INTERIM]', text: interimStr, timestamp: new Date().toISOString() },
            audience: { kind: 'all' }
          })
        }).catch(() => {});
      }

      // Emit final ONLY if new finalized words were added
      if (finalStr.length > previousFinal.length) {
         const newWords = finalStr.substring(previousFinal.length).trim();
         if (newWords.length > 0) {
            previousFinal = finalStr;
            fetch('/dev/emit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'TRANSCRIPT_CHUNK',
                payload: { speaker: participantName, text: newWords, timestamp: new Date().toISOString() },
                audience: { kind: 'all' }
              })
            }).catch(() => {});
         }
      }
    };
    
    try { recognition.start(); } catch(e){}
    return () => {
      recognition.onend = null;
      recognition.stop();
    };
  }, [participantName, isMicrophoneEnabled]);

  if (!isListening) return null;
  return (
    <div style={{ position: 'absolute', top: '10px', right: '10px', background: 'rgba(0,0,0,0.5)', color: 'white', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', pointerEvents: 'none' }}>
      🎙️ Local STT Active
    </div>
  );
}
