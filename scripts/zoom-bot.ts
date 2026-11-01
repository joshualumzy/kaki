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
      '--window-size=1280,720'
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  const joinUrl = `https://app.zoom.us/wc/join/${ZOOM_MEETING_ID}`;
  console.log(`Navigating to ${joinUrl}...`);
  await page.goto(joinUrl, { waitUntil: 'networkidle2' });

  try {
    console.log('Filling out join form...');
    
    // Wait for the name input. Sometimes Zoom asks for cookies first.
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
    console.log('Clicked Join... waiting 5 seconds then taking a screenshot of the waiting room state.');
    
    await new Promise(r => setTimeout(r, 5000));
    await page.screenshot({ path: 'scratch-zoom-waiting.png' });
    console.log('Screenshot saved to scratch-zoom-waiting.png');

    console.log('Waiting to be admitted into the meeting room (up to 60s)...');
    
    // Check if there is an audio join button, or a "Got it" for recording popup
    try {
      await page.waitForSelector('.join-audio-by-voip__join-btn', { timeout: 60000 });
      await page.click('.join-audio-by-voip__join-btn');
      console.log('Joined audio!');
    } catch (err) {
      console.log('Failed to find audio join button. Taking error screenshot...');
      await page.screenshot({ path: 'scratch-zoom-error.png' });
      throw err;
    }

    console.log('Bot is now in the meeting! Press Ctrl+C to stop.');

  } catch (err) {
    console.error('Error joining meeting:', err);
    await browser.close();
  }
}

joinZoomMeeting().catch(console.error);
