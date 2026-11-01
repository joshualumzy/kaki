import { Room, AudioSource, AudioFrame, RemoteAudioTrack, RoomEvent, AudioStream, LocalAudioTrack } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { TrackPublishOptions } from '@livekit/rtc-ffi-bindings';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import * as dotenv from 'dotenv';
import { llmFromEnv, type ChatMessage } from '../server/src/llm.js';
import WebSocket from 'ws';

dotenv.config();

const LIVEKIT_URL = process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY!;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION!;

const llm = llmFromEnv();
const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
speechConfig.speechRecognitionLanguage = "en-US";
// Voice is now dynamic based on speaker 
speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm;

// Drastically reduce Azure's silence timeout so 'recognized' fires much faster
speechConfig.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "500");
speechConfig.setProperty(sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs, "500");

const messageHistory: ChatMessage[] = [];

async function createToken(participantName: string) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: participantName,
    name: participantName,
  });
  at.addGrant({ roomJoin: true, room: 'HawkerHeroesLaunch', canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

async function playAudio(source: AudioSource, audioData: ArrayBuffer, interruptSignal: { interrupted: boolean }) {
  const int16Data = new Int16Array(audioData);
  const sampleRate = 16000;
  const numChannels = 1;
  const samplesPerFrame = sampleRate / 100; // 10ms frames = 160 samples
  
  const startTime = Date.now();
  let framesPushed = 0;

  for (let i = 0; i < int16Data.length; i += samplesPerFrame) {
    const chunk = int16Data.slice(i, i + samplesPerFrame);
    if (chunk.length < samplesPerFrame) break;
    if (interruptSignal && interruptSignal.interrupted) {
      console.log("[NPC] Interrupted audio playback");
      break;
    }
    
    const frame = new AudioFrame(chunk, sampleRate, numChannels, samplesPerFrame);
    await source.captureFrame(frame);
    framesPushed++;

    // Pace the audio pushing to roughly 10ms per frame
    const expectedTime = startTime + framesPushed * 10;
    const now = Date.now();
    if (expectedTime > now) {
      await new Promise(r => setTimeout(r, expectedTime - now));
    }
  }
}

async function startNpc(name: string, role: string, systemPrompt: string) {
  console.log(`Starting NPCs: Arjun and Maya`);
  
  // Connect Arjun
  const arjunRoom = new Room();
  const arjunToken = await createToken('Arjun');
  await arjunRoom.connect(LIVEKIT_URL, arjunToken);
  const arjunSource = new AudioSource(16000, 1);
  const arjunTrack = LocalAudioTrack.createAudioTrack('microphone', arjunSource);
  await arjunRoom.localParticipant?.publishTrack(arjunTrack, new TrackPublishOptions({ name: 'microphone', source: 2 as any }));
  
  // Connect Maya
  const mayaRoom = new Room();
  const mayaToken = await createToken('Maya');
  await mayaRoom.connect(LIVEKIT_URL, mayaToken);
  const mayaSource = new AudioSource(16000, 1);
  const mayaTrack = LocalAudioTrack.createAudioTrack('microphone', mayaSource);
  await mayaRoom.localParticipant?.publishTrack(mayaTrack, new TrackPublishOptions({ name: 'microphone', source: 2 as any }));

  // Listen to human from Arjun's connection
  const room = arjunRoom;

  messageHistory.push({ role: 'system', content: systemPrompt });

  let isGenerating = false;
  const sentenceQueue: string[] = [];
  const speakerBuffers: Record<string, string> = {};
  let isPlaying = false;
  let fullResponse = "";
  let silenceTimer: NodeJS.Timeout | null = null;
  let humanBuffer = "";
  let humanName = "User"; // Default fallback
  let lastEmittedEcho = "";
  
  // Listen to local Web Speech API events from the frontend instead of using Azure STT
  const ws = new WebSocket('ws://localhost:3001/ws?role=producer');
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'TRANSCRIPT_CHUNK') {
         const speaker = msg.payload.speaker;
         if (speaker !== 'Arjun' && speaker !== 'Maya' && speaker !== 'System' && speaker !== 'Arjun [INTERIM]' && speaker !== 'Maya [INTERIM]') {
            
            const text = msg.payload.text.trim();
            if (text.length === 0) return;
            
            // Acoustic Feedback Blocker:
            // Check if the STT picked up the AI's own voice from the speakers
            const normalizedText = text.toLowerCase().replace(/[^a-z0-9 ]/g, '');
            // For both interim and final, if it's an echo, block it entirely so it doesn't interrupt the AI
            const isEcho = lastSynthesizedTexts.some(aiText => normalizedText.includes(aiText) || aiText.includes(normalizedText));
            if (isEcho) {
               console.log(`[Echo Blocker] Ignored acoustic feedback: ${text}`);
               return;
            }

            if (speaker.endsWith(' [INTERIM]')) {
               if (isGenerating) {
                  console.log("[NPC] Human interrupted via Web Speech API!");
                  currentInterruptSignal.interrupted = true;
                  isGenerating = false;
                  
                  // Clear AI text UI
                  fetch("http://localhost:3001/dev/emit", { 
                     method: "POST", 
                     headers: { "Content-Type": "application/json" }, 
                     body: JSON.stringify({ 
                       type: "TRANSCRIPT_CHUNK", 
                       payload: { speaker: 'System', text: "", timestamp: new Date().toISOString() }, 
                       audience: { kind: "all" } 
                     }) 
                   }).catch(() => {});
               }
            } else {
               humanName = speaker; // Auto-update humanName from frontend STT!
               
               humanBuffer += (humanBuffer.length > 0 ? " " : "") + text; // Append strictly new diffed words
               console.log(`[Local STT] Final Text: ${text}`);
               
               if (isGenerating) {
                  currentInterruptSignal.interrupted = true;
                  isGenerating = false;
               }
               if (silenceTimer) clearTimeout(silenceTimer);
               // Debounce LLM triggers by 800ms so we don't spam the API with half-sentences
               silenceTimer = setTimeout(() => { triggerLLM(); }, 800);
            }
         }
      }

    } catch(e) {}
  });

  let lastRecognizingEmit = 0;
  let currentInterruptSignal = { interrupted: false };
  let lastSynthesizedTexts: string[] = [];

  const playNextSentence = async () => {
        if (isPlaying || sentenceQueue.length === 0 || currentInterruptSignal.interrupted) return;
        isPlaying = true;
        
        const sentence = sentenceQueue.shift()!;
        const match = sentence.match(/^([^:]+):\s*(.*)$/);
        let speakerName = name;
        let speakText = sentence;
        
        if (match) {
          speakerName = match[1].trim();
          speakText = match[2].trim();
        }
        
        // Accumulate text per speaker for the UI
        if (!speakerBuffers[speakerName]) speakerBuffers[speakerName] = "";
        speakerBuffers[speakerName] += (speakerBuffers[speakerName] ? " " : "") + speakText;
        
        console.log(`[${new Date().toISOString()}] [TTS] ${speakerName} Synthesizing: ${speakText}`);
        
        // Dynamically assign voice
        if (speakerName === 'Maya') {
          speechConfig.speechSynthesisVoiceName = "en-US-AriaNeural";
        } else {
          speechConfig.speechSynthesisVoiceName = "en-US-DavisNeural"; // Arjun's new voice
        }
        
        // Emit speaker's speech to Kaki
        fetch('http://localhost:3001/dev/emit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'TRANSCRIPT_CHUNK',
            payload: { speaker: speakerName, text: speakerBuffers[speakerName], timestamp: new Date().toISOString() },
            audience: { kind: 'all' }
          })
        }).catch(e => console.error('Failed to emit transcript:', e));
        
        const synthesizer = new sdk.SpeechSynthesizer(speechConfig);
        await new Promise<void>((resolve) => {
          lastSynthesizedTexts.push(speakText.toLowerCase().replace(/[^a-z0-9 ]/g, ''));
          if (lastSynthesizedTexts.length > 5) lastSynthesizedTexts.shift();
          synthesizer.speakTextAsync(speakText, async (result) => {

            if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
              if (!currentInterruptSignal.interrupted) {
                try {
                  const activeSource = speakerName === 'Maya' ? mayaSource : arjunSource;
                  await playAudio(activeSource, result.audioData, currentInterruptSignal);
                } catch (err) {
                  console.error("Audio playback error:", err);
                }
              }
            }
            synthesizer.close();
            resolve();
          }, (err) => {
            console.error("TTS Error", err);
            synthesizer.close();
            resolve();
          });
        });
        
        isPlaying = false;
        playNextSentence();
      };

  async function triggerLLM(isInitialKickoff = false) {
    if (isGenerating || (!isInitialKickoff && humanBuffer.trim().length === 0)) return;
    isGenerating = true;
    
    const localInterrupt = { interrupted: false };
    currentInterruptSignal = localInterrupt;

    fullResponse = "";
    sentenceQueue.length = 0;
    if (!isInitialKickoff) {
      
      const logTs = () => new Date().toISOString();
      const text = humanBuffer;
      humanBuffer = "";
      lastEmittedEcho = text; // Track this exact string so the WS listener drops it when it bounces back!

      console.log(`[${logTs()}] [Human] ${text}`);
      messageHistory.push({ role: 'user', content: text });
      
      // Emit human's speech to Kaki
      fetch('http://localhost:3001/dev/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'TRANSCRIPT_CHUNK',
          payload: { speaker: humanName, text, timestamp: new Date().toISOString() },
          audience: { kind: 'all' }
        })
      }).catch(e => console.error('Failed to emit transcript:', e));
    }
    
    try {
      const logTs = () => new Date().toISOString();
      console.log(`[${logTs()}] [LLM] Requesting stream...`);
      
      // Emit 'thinking' indicator instantly
      fetch('http://localhost:3001/dev/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'TRANSCRIPT_CHUNK',
          payload: { speaker: 'System', text: '💭 Thinking...', timestamp: new Date().toISOString() },
          audience: { kind: 'all' }
        })
      }).catch(e => console.error('Failed to emit thinking indicator:', e));
      

      

      const stream = llm!.stream!(messageHistory);
      let buffer = "";
      
      for await (const chunk of stream) {
        if (currentInterruptSignal.interrupted) break;
        buffer += chunk;
        fullResponse += chunk;
        
        while (true) {
          const match = buffer.match(/^(.*?[.!?])(?:\s+|$)(.*)$/s);
          if (match) {
            const sentence = match[1].trim();
            buffer = match[2] || "";
            if (sentence.length > 0) {
              sentenceQueue.push(sentence);
              playNextSentence();
            }
          } else {
            break;
          }
        }
      }
      
      if (buffer.trim().length > 0 && !currentInterruptSignal.interrupted) {
        sentenceQueue.push(buffer.trim());
        playNextSentence();
      }
      
      if (!currentInterruptSignal.interrupted) {
        messageHistory.push({ role: 'assistant', content: fullResponse });
        console.log(`[${name}] ${fullResponse}`);
      }
      
      // Wait until playback is done
      while ((isPlaying || sentenceQueue.length > 0) && !currentInterruptSignal.interrupted) {
        await new Promise(r => setTimeout(r, 100));
      }
      
      isGenerating = false;
      
    } catch (e) {
      console.error("LLM Error", e);
      isGenerating = false;
      fetch('http://localhost:3001/dev/emit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'TRANSCRIPT_CHUNK',
          payload: { speaker: 'System', text: 'Error: School LLM API is rate-limiting us (HTTP 429). Wait a minute.', timestamp: new Date().toISOString() },
          audience: { kind: 'all' }
        })
      }).catch(() => {});
    }
  }

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    console.log(`[Room] ${participant.identity} joined`);
  });

  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    // Ignore other NPCs so Arjun doesn't transcribe Maya's audio!
    if (participant.identity === 'Arjun' || participant.identity === 'Maya') return;

    console.log(`[Room] Subscribed to track ${track.sid} from ${participant.identity} (kind: ${track.kind})`);
    
    if (participant.name || participant.identity) {
      humanName = participant.name || participant.identity;
      const role = participant.metadata || "Producer";
      if (!messageHistory.some(m => m.role === 'system' && m.content.includes("joined the meeting"))) {
        messageHistory.push({
           role: 'system',
           content: `The human user has joined the meeting. Their name is "${humanName}" and their role is "${role}". You MUST address them by their actual name, not just their role. Greet them by name when they first speak or when you address them.`
        });
        console.log(`[Context] Injected human context: ${humanName} as ${role}`);
      }

      
      // Inject human's exact name and role into the LLM context dynamically
      messageHistory.push({
        role: 'system', 
        content: `The human user has joined the meeting. Their name is ${humanName}, and their role is ${role}. Address them by their name when speaking to them directly.`
      });
      console.log(`[NPC] Logged human entry: ${humanName} (${role})`);
    }
    if (track.kind === 1 /* KIND_AUDIO */) {
      const stream = new AudioStream(track as RemoteAudioTrack);
      let pushStream: sdk.PushAudioInputStream | null = null;
      let recognizer: sdk.SpeechRecognizer | null = null;
      let frameCount = 0;

      for await (const frame of stream) {
        frameCount++;
        if (frameCount % 100 === 0) {
           console.log(`[AudioStream] Received ${frameCount} frames from ${participant.identity}`);
        }
        if (!pushStream) {
          console.log(`[AudioStream] Stream initialized but Azure STT is disabled to save credits.`);
          pushStream = true as any; // hack to prevent reinit
        }
      }
    }
  });

  // Kick off the conversation
  // setTimeout(() => {
  //   humanBuffer = " (Hi Arjun, I'm here. What's the emergency?) ";
  //   triggerLLM();
  // }, 3000);
}

async function main() {
  await startNpc('Director', 'Meeting Host', `
You are the AI Director controlling two characters in a meeting with a human user (their name and role will be provided when they join):
1. Arjun: The Lead Programmer. He is stressed but empathetic. He knows the in-game store is crashing the game 1 hour before launch. He needs a decision: delay the launch, or disable the store.
2. Maya: The Creative Director. She is calm, supportive, and tries to mediate between Arjun and the human user. She wants to ensure the players have a good experience.

Respond dynamically based on what the human user says. ONLY have the character(s) speak if it makes sense. If the user addresses Maya, ONLY Maya should answer. If the user addresses Arjun, ONLY Arjun should answer. DO NOT make them both speak every time. Mix up the order of who speaks first if both need to speak. 
CRITICAL RULE: You MUST start every single sentence with the character's name followed by a colon. 
Example:
Arjun: I know this is stressful, but the store is crashing the game.
Maya: Arjun is right, we need to make a tough call here.

Keep responses natural, empathetic, and relatively short (1-4 sentences).
  `.trim());
}

main().catch(console.error);
