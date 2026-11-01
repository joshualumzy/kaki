import "dotenv/config";
import * as fs from "fs";
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

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      handleSIGINT: false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-notifications',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });

    const page = await browser.newPage();
    page.on("console", msg => console.log("BROWSER:", msg.text()));
    
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.setViewport({ width: 1280, height: 720 });

    const joinUrl = `https://app.zoom.us/wc/join/${ZOOM_MEETING_ID}`;
    console.log(`Navigating to ${joinUrl}...`);
    await page.goto(joinUrl, { waitUntil: 'networkidle2' });

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

    await new Promise(r => setTimeout(r, 1000));
    await page.click('.preview-join-button');
    console.log('Clicked Join...');
    
    console.log('Waiting to be admitted into the meeting room...');
    
    try {
      let checkCount = 0;
      let admitted = false;
      while (checkCount < 30) {
        checkCount++;
        
        const inMeeting = await page.evaluate(() => {
          return !!document.querySelector('.meeting-client-inner') && !document.querySelector('.meeting-on-hold') && !document.querySelector('.waiting-room-container');
        });
        
        if (inMeeting) {
          admitted = true;
          console.log('Main meeting UI detected! We are in.');
          break;
        }
        
        const pageText = await page.evaluate(() => document.body.innerText);
        if (pageText.includes("Automated bots aren't allowed")) {
           console.log("Zoom blocked us: Automated bots aren't allowed.");
        } else if (pageText.includes("Please wait, the meeting host will let you in soon")) {
           if (checkCount % 5 === 0) console.log("Still in waiting room...");
        } else if (pageText.includes("This meeting is for authorized attendees only")) {
           console.log("Zoom blocked us: Meeting requires authentication.");
           break;
        }
        
        await new Promise(r => setTimeout(r, 2000));
      }
      
      if (!admitted) {
         console.log('Timed out waiting to be admitted. Dumping DOM...');
         const dom = await page.evaluate(() => document.body.innerHTML);
         fs.writeFileSync("scratch-dom.html", dom);
         throw new Error("Timed out waiting to be admitted to the meeting.");
      }
      
      await new Promise(r => setTimeout(r, 4000));
      
      try {
        const audioBtn = await page.$('.join-audio-by-voip__join-btn');
        if (audioBtn) {
          await audioBtn.click();
          console.log('Clicked the Join Audio button.');
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {}
      
      try {
        const muted = await page.evaluate(function() {
          const btns = Array.from(document.querySelectorAll('button'));
          const muteBtn = btns.find(b => {
            const text = (b.innerText || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return (text.includes('mute') || aria.includes('mute')) && 
                   !text.includes('unmute') && !aria.includes('unmute');
          });
          if (muteBtn) {
            muteBtn.click();
            return true;
          }
          return false;
        });
        if (muted) console.log('Microphone muted successfully.');
        else console.log('Could not find Mute button (may already be muted).');
      } catch (err) { console.error('Error muting mic:', err); }

      await new Promise(r => setTimeout(r, 500));

      try {
        const dom = await page.content();
        fs.writeFileSync("scratch-dom.html", dom);
        console.log("DOM dumped to scratch-dom.html for debugging.");
      } catch (e) { console.error("Error dumping DOM:", e); }

      try {
        const videoStopped = await page.evaluate(function() {
          const btns = Array.from(document.querySelectorAll('button'));
          const videoBtn = btns.find(b => {
            const text = (b.innerText || '').toLowerCase();
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return (text.includes('stop video') || text.includes('stop sending') || aria.includes('stop video') || aria.includes('stop sending my video')) && !text.includes('start');
          });
          if (videoBtn) {
            videoBtn.click();
            return true;
          }
          return false;
        });
        if (videoStopped) console.log('Video stopped successfully.');
        else console.log('Could not find Stop Video button (may already be stopped).');
      } catch (err) { console.error('Error stopping video:', err); }
      
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
      
      await page.exposeFunction('sendAudioPCM', (uint8ArrayData) => {
        if (uint8ArrayData && uint8ArrayData.length > 0) {
          const buf = Buffer.from(uint8ArrayData);
          pushStream.write(buf);
        }
      });
      
      await page.evaluate(`
        (() => {
          console.log('Starting audio interception setup...');
          window.audioCtx = new AudioContext({ sampleRate: 16000 });
          if (window.audioCtx.state === 'suspended') {
             window.audioCtx.resume();
          }
          
          const processor = window.audioCtx.createScriptProcessor(4096, 1, 1);
          processor.connect(window.audioCtx.destination);
          
          processor.onaudioprocess = function(e) {
            const inputData = e.inputBuffer.getChannelData(0);
            const pcm16 = new Int16Array(inputData.length);
            let hasAudio = false;
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
              let s = Math.max(-1, Math.min(1, inputData[i]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              if (pcm16[i] !== 0) hasAudio = true;
              sum += Math.abs(inputData[i]);
            }
            if (hasAudio) {
              if (!window.loggedFirstAudio) {
                console.log('Received first non-zero audio buffer. Avg amplitude: ' + (sum / inputData.length));
                window.loggedFirstAudio = true;
              }
              const uint8 = new Uint8Array(pcm16.buffer);
              // Convert Uint8Array to Array directly instead of string concat which can cause encoding issues with binary data
              window.sendAudioPCM(Array.from(uint8));
            }
          };

          const captureElements = function() {
            const els = document.querySelectorAll('audio, video');
            if (!window.loggedElementCount || window.loggedElementCount !== els.length) {
                console.log('Found ' + els.length + ' audio/video elements on page.');
                window.loggedElementCount = els.length;
            }
            els.forEach(function(el) {
              if (!el.dataset.captured) {
                el.dataset.captured = 'true';
                try {
                  console.log('Attempting to capture element:', el.tagName);
                  
                  // Zoom might use srcObject or just standard src
                  let source;
                  if (el.srcObject) {
                      source = window.audioCtx.createMediaStreamSource(el.srcObject);
                  } else {
                      source = window.audioCtx.createMediaElementSource(el);
                  }
                  
                  // Connect to our processor to capture, and also to destination so we can still hear it locally if needed
                  source.connect(processor);
                  // Not connecting to destination because we don't want echo from bot
                  
                  console.log('Successfully hooked audio stream from element:', el.tagName);
                } catch (err) {
                  console.error('Failed to hook element:', err.message);
                }
              }
            });
          };

          setInterval(captureElements, 2000);
        })();
      `);

      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      recognizer.recognizing = (s, e) => { console.log(`[Partial Transcript]: ${e.result.text}`); };
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

    let isShuttingDown = false;
    process.on('SIGINT', async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      
      console.log('\nStopping bot, leaving meeting, and closing browser...');
      try {
        console.log('Attempting to find Leave button...');
        const left = await page.evaluate(function() {
          const btns = Array.from(document.querySelectorAll('button'));
          const leave = btns.find(b => {
            if (b.offsetWidth === 0 || b.offsetHeight === 0) return false;
            const t = (b.innerText || '').toLowerCase();
            const a = (b.getAttribute('aria-label') || '').toLowerCase();
            return (t === 'leave' || t === 'leave meeting' || a === 'leave' || a === 'leave meeting');
          });
          if (leave) {
            leave.click();
            return true;
          }
          return false;
        });
        
        if (left) {
          console.log('Clicked initial Leave button. Waiting for confirmation prompt...');
          await new Promise(r => setTimeout(r, 1000));
          
          const confirmed = await page.evaluate(function() {
            const els = Array.from(document.querySelectorAll('button, div, span'));
            const confirmLeave = els.find(b => {
              if (b.offsetWidth === 0 || b.offsetHeight === 0) return false;
              const t = (b.innerText || '').toLowerCase().trim();
              return t === 'leave meeting' || t === 'leave';
            });
            if (confirmLeave) {
              confirmLeave.click();
              return true;
            }
            return false;
          });
          
          if (confirmed) {
            console.log('Clicked Leave Meeting confirmation!');
            await new Promise(r => setTimeout(r, 5000));
          } else {
            console.log('Could not find confirmation button. Force closing browser anyway.');
          }
        } else {
          console.log('Could not find initial Leave button. Force closing browser anyway.');
        }
      } catch (e) {
      }
      if (browser) {
        console.log("Closing browser...");
        await browser.close();
        console.log("Browser closed.");
      }
      process.exit(0);
    });

  } catch (err) {
    console.error('Error joining meeting:', err);
    if (browser) await browser.close();
  }
}

joinZoomMeeting().catch(console.error);
