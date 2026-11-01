import "dotenv/config";
import * as fs from "fs";
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
import type { Browser, Page } from 'puppeteer';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

puppeteer.use(StealthPlugin());

const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID;
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE;
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;

async function joinZoomMeeting() {
  if (!ZOOM_MEETING_ID || !ZOOM_PASSCODE) {
    console.error('Please provide ZOOM_MEETING_ID and ZOOM_PASSCODE environment variables.');
    process.exit(1);
  }

  const cleanMeetingId = ZOOM_MEETING_ID.replace(/[^0-9]/g, "");
  console.log(`Starting Zoom bot to join meeting ${cleanMeetingId}...`);

  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    browser = await puppeteer.launch({
      headless: false,
      handleSIGINT: false,
      userDataDir: './.zoom-bot-profile', // Extremely important for retaining trust and bypassing WAFs
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-notifications',
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '--no-sandbox',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required'
      ],
      ignoreDefaultArgs: ['--enable-automation']
    });

    page = await browser.newPage();
    
    // Evade some basic bot detections
    await page.evaluateOnNewDocument(() => {
      delete (Object.getPrototypeOf(navigator) as any).webdriver;
      (window.navigator as any).chrome = {
        runtime: {}
      };
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    // Suppress noisy CSP logs from Zoom
    page.on("console", msg => {
      if (!msg.text().includes("Content Security Policy")) {
        console.log("BROWSER:", msg.text());
      }
    });
    
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    const joinUrl = `https://app.zoom.us/wc/join/${cleanMeetingId}`;
    console.log(`Navigating to ${joinUrl}...`);
    await page.goto(joinUrl, { waitUntil: 'networkidle2' });

    console.log('Filling out join form...');
    
    // 1. Accept Cookies if present
    try {
      const cookieBtn = await page.$('#onetrust-accept-btn-handler');
      if (cookieBtn) {
        await cookieBtn.click();
        console.log('Accepted cookies.');
      }
    } catch(e) {}

    // 2. Fill Name & Passcode
    try {
      await page.waitForSelector('input[id="input-for-name"], input#inputname', { timeout: 15000 });
      try { 
        await page.type('input[id="input-for-name"]', 'Kaki Bot'); 
      } catch(e) { 
        await page.type('input#inputname', 'Kaki Bot'); 
      }
      
      if (await page.$('input[id="input-for-pwd"]')) {
        await page.type('input[id="input-for-pwd"]', ZOOM_PASSCODE);
      }

      await new Promise(r => setTimeout(r, 1000));
      await page.click('.preview-join-button');
      console.log('Clicked Join...');
    } catch (e) {
      console.log('Notice: Could not find or fill the join form. Zoom might have skipped it or blocked us early.');
    }
    
    console.log('Waiting to be admitted into the meeting room...');
    
    // 3. Wait for Admission
    let admitted = false;
    let checkCount = 0;
    while (checkCount < 30) {
      checkCount++;
      
      const inMeeting = await page.evaluate(() => {
        return !!document.querySelector('.meeting-client-inner') && 
               !document.querySelector('.meeting-on-hold') && 
               !document.querySelector('.waiting-room-container');
      });
      
      if (inMeeting) {
        admitted = true;
        console.log('Main meeting UI detected! We are in.');
        break;
      }
      
      const pageText = await page.evaluate(() => document.body.innerText);
      if (pageText.includes("Automated bots aren't allowed")) {
          console.log("Zoom blocked us: Automated bots aren't allowed.");
          // Sometimes clicking refresh or trying again helps, but usually we just need to fail gracefully here.
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
    
    // 4. Setup AV (Join Audio, Mute Mic, Stop Video)
    let avAttempts = 0;
    let avDone = false;
    console.log('Attempting to turn off Microphone and Video...');
    while (avAttempts < 40 && !avDone) {
      avAttempts++;
      try {
        const audioBtn = await page.$('.join-audio-by-voip__join-btn');
        if (audioBtn) await audioBtn.click();
      } catch (err) {}
      
      try {
        avDone = await page.evaluate(function() {
          const btns = Array.from(document.querySelectorAll('button'));
          let muted = false;
          let videoStopped = false;
          
          const muteBtn = btns.find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria === 'mute my microphone' || aria === 'mute';
          });
          if (muteBtn) {
            muteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            muteBtn.click();
          } else {
            const unmutedBtn = btns.find(b => {
              const a = (b.getAttribute('aria-label') || '').toLowerCase();
              const t = (b.textContent || '').toLowerCase();
              return a.includes('unmute') || t.includes('unmute');
            });
            if (unmutedBtn) muted = true;
            else muted = true; // Failsafe: if neither mute nor unmute is found, assume it's disabled/muted
          }
          
          const videoBtn = btns.find(b => {
            const aria = (b.getAttribute('aria-label') || '').toLowerCase();
            return aria === 'stop video' || aria === 'stop sending my video' || aria === 'stop my video';
          });
          if (videoBtn) {
            videoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            videoBtn.click();
          } else {
            const startVideoBtn = btns.find(b => {
              const a = (b.getAttribute('aria-label') || '').toLowerCase();
              const t = (b.textContent || '').toLowerCase();
              return a.includes('start video') || t.includes('start video');
            });
            if (startVideoBtn) videoStopped = true;
            else videoStopped = true; // Failsafe: if neither stop nor start is found, assume it's disabled/stopped
          }
          
          return muted && videoStopped;
        });
        if (avDone) {
          console.log('Microphone and Video successfully turned off.');
        }
      } catch (err) {}
      
      if (!avDone) await new Promise(r => setTimeout(r, 250));
    }

    // 5. Azure Speech Setup
    if (AZURE_SPEECH_KEY && AZURE_SPEECH_REGION) {
      console.log('Azure Speech credentials found. Initializing real-time transcription...');
      
      const speechConfig = sdk.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
      speechConfig.speechRecognitionLanguage = 'en-US';
      
      const pushStream = sdk.AudioInputStream.createPushStream();
      const audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
      
      await page.exposeFunction('sendAudioPCM', (uint8ArrayData: number[]) => {
        if (uint8ArrayData && uint8ArrayData.length > 0) {
          const uint8 = new Uint8Array(uint8ArrayData);
          // Get a clean ArrayBuffer to pass to Azure SDK
          const arrayBuffer = uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
          pushStream.write(arrayBuffer);
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
              // Convert to standard Array for exposeFunction serialization
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
                  let source;
                  if (el.srcObject) {
                      source = window.audioCtx.createMediaStreamSource(el.srcObject);
                  } else {
                      source = window.audioCtx.createMediaElementSource(el);
                  }
                  source.connect(processor);
                  console.log('Successfully hooked audio stream from element:', el.tagName);
                } catch (err) {
                  console.error('Failed to hook element:', err.message);
                }
              }
            });
          };

          setInterval(captureElements, 200);
        })();
      `);

      const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
      
      recognizer.recognizing = (s, e) => { 
        console.log(`[Partial Transcript]: ${e.result.text}`); 
      };
      
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

    // 6. Graceful Shutdown & Leave Handling
    let isShuttingDown = false;
    process.on('SIGINT', async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      
      console.log('\nStopping bot, leaving meeting, and closing browser...');
      try {
        if (page) {
          console.log('Attempting to find Leave button...');
          let left = false;
          try {
            left = await page.evaluate(() => {
              // Extremely aggressive search for Leave/End button
              const elements = Array.from(document.querySelectorAll('button, div, span, a'));
              
              const leaveEl = elements.find(el => {
                // Must be visible
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                
                const txt = (el.textContent || '').trim().toLowerCase();
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const cls = (el.className || '').toLowerCase();
                
                // Explicitly check for Zoom's footer red button text/aria
                if (aria === 'leave' || aria === 'end' || aria === 'leave meeting') return true;
                if (txt === 'leave' || txt === 'end' || txt === 'exit') return true;
                if (cls.includes('leave-btn') || cls.includes('leave')) return true;
                return false;
              });

              if (leaveEl) {
                // Native click + dispatch fallback
                (leaveEl as HTMLElement).click();
                leaveEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
              }
              return false;
            });
          } catch(e) {}
          
          if (left) {
            console.log('Clicked initial Leave button. Waiting for confirmation prompt...');
            await new Promise(r => setTimeout(r, 1000));
            
            let confirmed = false;
            try {
              confirmed = await page.evaluate(() => {
                // If the modal isn't rendering exactly as we expect, we fallback to searching the whole document again
                const elements = Array.from(document.querySelectorAll('button, a'));
                const confirmEl = elements.find(el => {
                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden') return false;
                  
                  const txt = (el.textContent || '').trim().toLowerCase();
                  
                  // In the confirmation popup, the button is often simply 'Leave Meeting'
                  // If it's a button, and it has 'leave' in it, and it's NOT the footer button we just clicked...
                  if ((txt.includes('leave') || txt.includes('end')) && !el.closest('.footer__inner')) {
                    return true;
                  }
                  return false;
                });

                if (confirmEl) {
                  (confirmEl as HTMLElement).click();
                  confirmEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                  return true;
                }
                return false;
              });
            } catch(e) {}
            
            if (confirmed) {
              console.log('Clicked Leave Meeting confirmation!');
              let verificationCount = 0;
              let successfullyLeft = false;
              // Wait up to 6 seconds for Zoom to process the leave
              while (verificationCount < 6) {
                verificationCount++;
                const stillInMeeting = await page.evaluate(() => {
                  return !!document.querySelector('.footer__inner, .meeting-client-inner');
                });
                
                if (!stillInMeeting) {
                  successfullyLeft = true;
                  console.log('SUCCESS: Verified the bot has left the meeting room. DOM elements are gone.');
                  // Wait 1 more second to ensure WebSocket has finished flushing the leave message
                  return new Promise(r => setTimeout(r, 1000));
                }
                await new Promise(r => setTimeout(r, 1000));
              }
              
              if (!successfullyLeft) {
                console.log('Bot is still in the meeting room after 6 seconds. Falling back to force disconnection.');
              }
            } else {
              console.log('Could not find confirmation button. Executing hard-fallback Zoom JS API leave...');
              try {
                // If DOM finding fails entirely, hook into Zoom's own internal Redux/React state dispatcher 
                // and force a client-side route change which triggers their native WebSockets to disconnect properly.
                await page.evaluate(() => {
                   window.dispatchEvent(new Event('beforeunload'));
                   window.dispatchEvent(new Event('unload'));
                   window.location.replace('https://zoom.us/join');
                });
                await new Promise(r => setTimeout(r, 2000));
              } catch(e) {}
            }
          } else {
            console.log('Could not find initial Leave button. Attempting fallback navigation...');
            try {
              // Graceful navigation fallback to trigger Zoom's unload beacons
              await page.evaluate(() => { window.location.href = 'https://zoom.us/'; });
              await new Promise(r => setTimeout(r, 2000));
            } catch(e) {}
          }
        }
      } catch (e) {
        console.error('Error during graceful leave:', e);
      }
      
      if (page) {
        console.log("Force navigating away to drop connection instantly...");
        try { 
          await page.goto('about:blank'); 
          await new Promise(r => setTimeout(r, 1000)); 
        } catch(e) {}
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
    if (page) {
      try { await page.screenshot({ path: 'scratch-fatal-error.png' }); } catch(e) {}
    }
    if (browser) await browser.close();
  }
}

joinZoomMeeting().catch(console.error);
