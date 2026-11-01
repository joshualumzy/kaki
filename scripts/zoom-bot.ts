import "dotenv/config";
import puppeteer from 'puppeteer';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID;
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;

async function joinZoomMeeting() {
  if (!ZOOM_MEETING_ID || !ZOOM_PASSCODE) {
    console.error('Please provide ZOOM_MEETING_ID and ZOOM_PASSCODE environment variables.');
    process.exit(1);
  }

  console.log(`Starting Zoom bot to join meeting ${ZOOM_MEETING_ID}...`);

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-notifications',
      '--window-size=1280,720',
      '--disable-blink-features=AutomationControlled' // Helps bypass basic bot detection
    ],
  });

  const page = await browser.newPage();
  
  // Set a normal user agent to avoid looking like a headless bot
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 720 });

  const joinUrl = `https://app.zoom.us/wc/join/${ZOOM_MEETING_ID}`;
  console.log(`Navigating to ${joinUrl}...`);
  await page.goto(joinUrl, { waitUntil: 'networkidle2' });

  try {
    console.log('Filling out join form...');
    
    try {
      const cookieBtn = await page.$('#onetrust-accept-btn-handler');
      if (cookieBtn) {
        await cookieBtn.click();
        console.log('Accepted cookies.');
      }
    } catch(e) {}

    await page.waitForSelector('input[id="input-for-name"]', { timeout: 10000 });
    await page.type('input[id="input-for-name"]', 'Kaki Bot');
    
    if (await page.$('input[id="input-for-pwd"]')) {
      await page.type('input[id="input-for-pwd"]', ZOOM_PASSCODE);
    }

    await page.click('.preview-join-button');
    console.log('Clicked Join...');
    
    console.log('Waiting to be admitted into the meeting room...');
    
    // Zoom usually auto-joins the computer audio on Chromium when fake-ui flags are active.
    // Instead of waiting specifically for the audio button, we wait for the main meeting UI to appear.
    try {
      // The footer bar is a good indicator that we are actually in the meeting
      await page.waitForSelector('.footer__inner', { timeout: 120000 });
      console.log('Main meeting UI detected! We are in.');
      
      // Sometimes the "Join Audio by Computer" button still pops up even if the footer is there
      try {
        const audioBtn = await page.$('.join-audio-by-voip__join-btn');
        if (audioBtn) {
          await audioBtn.click();
          console.log('Clicked the Join Audio button.');
        }
      } catch (err) {}
      
    } catch (err) {
      console.log('Failed to detect meeting UI. Taking error screenshot...');
      await page.screenshot({ path: 'scratch-zoom-error.png' });
      throw err;
    }

    if (AZURE_SPEECH_KEY && AZURE_SPEECH_REGION) {
      console.log('Azure Speech credentials found. Initializing real-time transcription...');
      
      const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-US';
      
      const pushStream = sdk.AudioInputStream.createPushStream();
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      
      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      recognizer.recognized = async (s, e) => {
        if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
          console.log(`[Final Transcript]: ${e.result.text}`);
          
          const port = process.env.PORT ?? '3001';
          try {
            await fetch(`http://localhost:${port}/dev/emit`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                type: 'TRANSCRIPT_CHUNK',
                audience: { kind: 'screen' },
                payload: {
                  speaker: 'Unknown Attendee',
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
