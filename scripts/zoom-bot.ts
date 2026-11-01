import puppeteer from 'puppeteer-core';

const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID;
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE;
const GLADIA_API_KEY = process.env.GLADIA_API_KEY;

/**
 * SPIKE: Issue #14 - Zoom Attendee Bot
 * This script uses Puppeteer to open the Zoom Web Client in a headless browser,
 * join a meeting, and (eventually) capture audio to send to Gladia.
 */
async function joinZoomMeeting() {
  if (!ZOOM_MEETING_ID || !ZOOM_PASSCODE) {
    console.error('Please provide ZOOM_MEETING_ID and ZOOM_PASSCODE environment variables.');
    process.exit(1);
  }

  console.log(`Starting Zoom bot to join meeting ${ZOOM_MEETING_ID}...`);

  // Launch browser with flags to allow fake media (mic/camera) and bypass permissions
  const browser = await puppeteer.launch({
    headless: false, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // Set to true when deploying to Azure VM
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

    // 3. (TODO) Setup Gladia WebSockets
    // Once in the meeting, we need to capture the tab's audio using Chrome Extensions API
    // or by overriding the WebRTC audio context, then stream it to Gladia.
    if (GLADIA_API_KEY) {
      console.log('Gladia API Key found. Real-time transcription is ready to be implemented.');
      const deepgram = createClient(GLADIA_API_KEY);
      // ... Initialize Gladia Live WebSocket ...
    } else {
      console.warn('No GLADIA_API_KEY provided. Skipping transcription setup.');
    }

    console.log('Bot is now in the meeting! Press Ctrl+C to stop.');

  } catch (err) {
    console.error('Error joining meeting:', err);
    await browser.close();
  }
}

joinZoomMeeting().catch(console.error);
