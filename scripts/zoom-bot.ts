import puppeteer from 'puppeteer';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID;
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;

/**
 * SPIKE: Issue #14 - Zoom Attendee Bot
 * This script uses Puppeteer to open the Zoom Web Client in a headless browser,
 * join a meeting, and captures audio to send to Azure Speech Services.
 */
async function joinZoomMeeting() {
  if (!ZOOM_MEETING_ID || !ZOOM_PASSCODE) {
    console.error('Please provide ZOOM_MEETING_ID and ZOOM_PASSCODE environment variables.');
    process.exit(1);
  }

  console.log(`Starting Zoom bot to join meeting ${ZOOM_MEETING_ID}...`);

  // Launch browser with flags to allow fake media (mic/camera) and bypass permissions
  const browser = await puppeteer.launch({
    headless: false, // Set to true when deploying to Azure VM
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-notifications',
    ],
  });

  const page = await browser.newPage();

  // Go directly to the Zoom Web Client join page
  const joinUrl = `https://app.zoom.us/wc/join/${ZOOM_MEETING_ID}`;
  console.log(`Navigating to ${joinUrl}...`);
  await page.goto(joinUrl, { waitUntil: 'networkidle2' });

  try {
    // 1. Enter Passcode and Name
    console.log('Filling out join form...');
    await page.waitForSelector('input[id="input-for-name"]', { timeout: 10000 });
    await page.type('input[id="input-for-name"]', 'Kaki Bot');
    
    if (await page.$('input[id="input-for-pwd"]')) {
      await page.type('input[id="input-for-pwd"]', ZOOM_PASSCODE);
    }

    // Click "Join"
    await page.click('.preview-join-button');
    console.log('Clicked Join...');

    // 2. Wait for the meeting room to load and click "Join Audio by Computer"
    console.log('Waiting to be admitted into the meeting room...');
    await page.waitForSelector('.join-audio-by-voip__join-btn', { timeout: 60000 });
    await page.click('.join-audio-by-voip__join-btn');
    console.log('Joined audio!');

    // 3. Setup Azure Speech Services
    // Once in the meeting, we capture the virtual audio output (e.g. via Pulseaudio on Azure VM)
    // or by evaluating a script in the page context, and push it to Azure via PushAudioInputStream.
    if (AZURE_SPEECH_KEY && AZURE_SPEECH_REGION) {
      console.log('Azure Speech credentials found. Initializing real-time transcription...');
      
      const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-US';
      
      // For this spike, we create a PushAudioInputStream.
      // In full implementation, we will pipe the Zoom WebRTC audio stream into this pushStream.
      const pushStream = sdk.AudioInputStream.createPushStream();
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      recognizer.recognizing = (s, e) => {
        // Partial transcription result (useful for instant UI updates, though Kaki processes chunks)
        // console.log(`[Partial]: ${e.result.text}`);
      };

      recognizer.recognized = async (s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          console.log(`[Final Transcript]: ${e.result.text}`);
          
          // Send to Kaki server
          const port = process.env.PORT ?? '3001';
          try {
            await fetch(`http://localhost:${port}/dev/emit`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'TRANSCRIPT_CHUNK',
                audience: { kind: 'screen' },
                payload: {
                  speaker: 'Unknown Attendee', // TODO: Diarization or Zoom active speaker detection
                  text: e.result.text,
                  timestamp: new Date().toISOString()
                }
              }),
            });
          } catch (err) {
            console.error('Failed to send transcript to Kaki server:', err);
          }
        }
      };

      recognizer.startContinuousRecognitionAsync(
        () => console.log('Azure Speech continuous recognition started.'),
        (err) => console.error('Error starting Azure Speech:', err)
      );
      
    } else {
      console.warn('No AZURE_SPEECH_KEY or AZURE_SPEECH_REGION provided. Skipping transcription setup.');
    }

    console.log('Bot is now in the meeting! Press Ctrl+C to stop.');

  } catch (err) {
    console.error('Error joining meeting:', err);
    await browser.close();
  }
}

joinZoomMeeting().catch(console.error);
