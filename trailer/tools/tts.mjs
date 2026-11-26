// Azure Speech TTS: node trailer/tools/tts.mjs <lines.json> <outDir>
// lines.json: [{ "id": "s1-narr", "voice": "<key in VOICES>", "text": "..." }]
// or, for full control: { "id", "voice", "ssml": "<inner SSML of the <voice> element>" } (raw, not escaped; mstts namespace available).
// Writes <outDir>/<id>.wav (48 kHz 16-bit mono). Reads AZURE_SPEECH_KEY/REGION from the repo .env; never prints them.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const env = Object.fromEntries(readFileSync(new URL('../../.env', import.meta.url), 'utf8')
  .split('\n').filter((l) => /^AZURE_SPEECH_(KEY|REGION)=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const KEY = env.AZURE_SPEECH_KEY, REGION = env.AZURE_SPEECH_REGION;
if (!KEY || !REGION) throw new Error('AZURE_SPEECH_KEY/REGION missing in .env');
const VOICES = {
  narrator: { name: 'en-US-AndrewMultilingualNeural', rate: '-4%' },
  mei: { name: 'en-SG-LunaNeural', rate: '0%' },
  raj: { name: 'en-IN-PrabhatNeural', rate: '0%' },
  aisha: { name: 'en-GB-AdaMultilingualNeural', rate: '0%' },
  // v8 film voices (locked 26 Nov)
  tony: { name: 'en-US-TonyNeural', rate: '+6%' },
  xiaoke: { name: 'zh-CN-Xiaoke:DragonHDFlashLatestNeural', rate: '0%' },
  rosa: { name: 'en-PH-RosaNeural', rate: '0%' },
};
const [linesFile, outDir] = process.argv.slice(2);
if (!linesFile || !outDir) throw new Error('usage: tts.mjs <lines.json> <outDir>');
mkdirSync(outDir, { recursive: true });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const force = process.argv.includes('--force');
for (const line of JSON.parse(readFileSync(linesFile, 'utf8'))) {
  const v = VOICES[line.voice];
  if (!v) throw new Error(`unknown voice ${line.voice} for ${line.id}`);
  const out = join(outDir, `${line.id}.wav`);
  if (existsSync(out) && !force) continue;
  if (!line.ssml === !line.text) throw new Error(`${line.id}: give exactly one of text or ssml`);
  const inner = line.ssml ?? `<prosody rate="${v.rate}">${esc(line.text)}</prosody>`;
  const ssml = `<speak version="1.0" xml:lang="en-US" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts"><voice name="${v.name}">${inner}</voice></speak>`;
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-48khz-16bit-mono-pcm', 'User-Agent': 'video-tts' },
    body: ssml,
  });
  if (!res.ok) throw new Error(`TTS failed for ${line.id}: HTTP ${res.status} ${await res.text()}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`wrote ${out}`);
}
