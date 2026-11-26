// Builds timeline.json and media.ts for FilmV10 from the real WAV durations and voice amplitude.
// Run from trailer: node src/film/make-sfx.mjs && node src/film/build-timeline.mjs
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const folder = dirname(fileURLToPath(import.meta.url));
const repo = resolve(folder, '../../..');
const fps = 30;
const bpm = 115.02, phase = 0.03;
const beatFrame = (i) => Math.round((phase + i * 60 / bpm) * fps);
const snapNearest = (f) => beatFrame(Math.max(0, Math.round((f / fps - phase) * bpm / 60)));
const snapUp = (f) => {let i = Math.max(0, Math.floor((f / fps - phase) * bpm / 60)); while (beatFrame(i) < f) i++; return beatFrame(i);};
const snapBar = (f) => {let i = Math.max(0, Math.floor((f / fps - phase) * bpm / 60 / 4)); while (beatFrame(4 * i) < f) i++; return beatFrame(4 * i);};
const BEAT = 15.65;

const parseWav = (buf) => {
  let sr, align, ds, dl;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') {sr = buf.readUInt32LE(o + 12); align = buf.readUInt16LE(o + 20);}
    if (id === 'data') {ds = o + 8; dl = size;}
    o += 8 + size + size % 2;
  }
  return {sr, seconds: dl / align / sr, samples: dl / 2, ds};
};
const envelope = (buf) => {
  const {sr, samples, ds} = parseWav(buf), fl = sr / fps, rms = [];
  for (let f = 0; f * fl < samples; f++) {let a = 0, c = 0; for (let i = Math.floor(f * fl); i < Math.min(samples, Math.floor((f + 1) * fl)); i++) {const v = buf.readInt16LE(ds + 2 * i) / 32768; a += v * v; c++;} rms.push(Math.sqrt(a / Math.max(1, c)));}
  const sorted = [...rms].sort((a, b) => a - b), ref = sorted[Math.floor(sorted.length * .95)] || 1e-6;
  return rms.map((v) => Math.min(9, Math.round(v / ref * 9))).join('');
};

const wavDir = resolve(folder, '../../audio/voices');
const text = {
  'vo-open': 'Monday. Again. Thirty minutes to sort out the whole week.',
  mei1: "Raj, when does our packaging contract end? If it auto-renews, we're stuck with the new prices.",
  raj1: 'Uh... let me check.', mei2: "So who's emailing them about the renewal?", 'mei-later': "...Okay. We'll come back to it.", aisha1: 'Sorry, what did I miss?',
  'vo-weeks': 'Week after week, it slides... until the contract renews itself. At the new prices.',
  'vo-bridge': 'We kept seeing this. So we built Kaki: it sits in your meeting, helps everyone keep up, and actually gets the work done.',
  mei1b: 'Raj, when does our packaging contract end?',
  'vo-answer': "This time, Raj doesn't have to check. Kaki's already found it in the team's wiki, and only Raj can see it.",
  raj2: 'March 31st. We need to give notice by end of January.', raj3: "I'll email them this week.",
  'raj-groan': '', 'mei-moveon': "...Never mind. Let's just move on.", 'mei-goodpoint': 'Good catch, Aisha.',
  'vo-whywait': 'Hold on, Raj. This week? Why wait?', 'vo-task': "Kaki spots what you've agreed on and turns it into a task. Mei's running the meeting, so she picks who takes it.", 'vo-draft': 'Kaki writes the draft. Raj adds his own touch...', 'vo-sent': "Raj approves. Sent, before the call's even over.",
  aisha2: "If we switch suppliers, I'll need two weeks' notice for catering.",
  'vo-nudge': "This touches Aisha's catering, but she hasn't said a word. So Kaki catches her up, with something she could add.",
  'vo-tools': 'And not just email. Chat... GitHub... calendar... wiki. Kaki drafts, you approve.',
  'vo-end-minutes': "That's the meeting, on time. And the minutes are already written. Mei gives them a once-over, and they're on the wiki.",
  'vo-next': 'So next Monday starts where this one left off.',
  'mei-jade': 'Raj, what did Jade say?', 'raj-jade': "Sorted, boss. They're keeping the old prices.",
};
const order = Object.keys(text);
const buffers = Object.fromEntries(order.map((id) => [id, readFileSync(resolve(wavDir, `${id}.wav`))]));
const names = {narrator: 'Narrator', mei: 'Mei', raj: 'Raj', aisha: 'Aisha'};
const lines = order.map((id) => {
  const voice = id.startsWith('vo') ? 'narrator' : id.startsWith('mei') ? 'mei' : id.startsWith('raj') ? 'raj' : 'aisha';
  const sourceSeconds = parseWav(buffers[id]).seconds;
  return {id, voice, speaker: names[voice], text: text[id], sourceSeconds, playbackRate: 1, startFrame: 0, endFrame: 0, durFrames: Math.ceil(sourceSeconds * fps), amp: voice === 'narrator' ? '' : envelope(buffers[id])};
});
const L = (id) => lines.find((l) => l.id === id);
/** Cue point inside a line, as a fraction of its measured duration (so swapped recordings keep the cues in proportion). */
const fr = (id, frac) => Math.round(L(id).durFrames * frac);
const put = (id, start) => {const l = L(id); l.startFrame = Math.round(start); l.endFrame = l.startFrame + l.durFrames; return l;};

const E = {};
// ---- S1 cold open (world). Mei's sigh lands, Raj groans at the clock, then the narration.
E.buzz = 20; E.phonePush = 36; E.phonePushEnd = 66; E.phoneBack = 108; E.phoneBackEnd = 138;
E.sigh1 = 104; E.mugDown = 120;
E.rajShot = 144; put('raj-groan', E.rajShot + 30); E.aishaShot = L('raj-groan').endFrame + 4; E.meiShot4 = E.aishaShot + 60;
put('vo-open', E.aishaShot + 20);
E.reach = L('vo-open').endFrame + 26; E.lidStart = E.reach + 12; E.lidEnd = E.lidStart + 28; E.pushStart = E.lidEnd + 4; E.pushEnd = E.pushStart + 40; E.gridIn = E.pushEnd;
// ---- S3 the usual meeting
put('mei1', E.gridIn + 26); put('raj1', L('mei1').endFrame + 14); put('mei2', L('raj1').endFrame + 14);
E.silenceStart = L('mei2').endFrame;
put('mei-later', E.silenceStart + 75); put('aisha1', L('mei-later').endFrame + 26);
E.stepOut = L('raj1').startFrame + 40; E.stepBack = L('aisha1').startFrame - 22;
put('mei-moveon', L('aisha1').endFrame + 24);
E.rajRoll = L('mei-moveon').startFrame + 24;
E.rub = L('mei-moveon').endFrame + 8; E.pullStart = E.rub + 60; E.pullEnd = E.pullStart + 36;
// ---- S4 week after week
const v = E.pullEnd; put('vo-weeks', v);
const t0 = snapUp(v + 6);
E.tears = [0, 1, 2, 3].map((i) => t0 + Math.round(i * BEAT));
E.stickies = E.tears.map((t) => t + 8);
E.envIn = snapUp(v + fr('vo-weeks', .35)); E.flapOpen = E.envIn + 24; E.letterUp = E.envIn + 30; E.letterPush = E.envIn + 34; E.letterReady = E.letterPush + 34;
E.faceIn = v + L('vo-weeks').durFrames - 26; E.faceFace = E.faceIn + 24;
const faceEnd = v + L('vo-weeks').durFrames + 56;
E.rewind = faceEnd;
// ---- S5 bridge
const r = E.rewind;
E.rewindPages = [0, 1, 2, 3].map((i) => r + 22 + i * 8); E.rewindNotes = [0, 1, 2, 3].map((i) => r + 24 + i * 6); E.rewindEnv = r + 18;
E.push2Start = r + 86; E.push2End = r + 86 + 30; E.grid2 = E.push2End;
E.cup = [0, 1, 2].map((i) => snapUp(E.grid2 + 2) + Math.round(i * BEAT));
E.warmStart = E.cup[0] - 4; // the colour comes back with Mei's smile when the first cup lands, never while she is still in dismay
put('vo-bridge', E.cup[0] - fr('vo-bridge', .29));
E.bridgeEnd = L('vo-bridge').endFrame;
// ---- S6 answer
put('mei1b', E.bridgeEnd + 16);
const m1 = L('mei1b').endFrame;
E.answerGlow = m1 + 3; E.answerLayout = m1 + 6; E.answerIn = E.answerLayout + 56; // the tiles finish their move (54 f) before the card appears
put('vo-answer', m1 + 32);
put('raj2', L('vo-answer').endFrame + 14);
E.answerOut = L('raj2').endFrame + 8;
put('raj3', L('raj2').endFrame + 36);
// ---- S7 agreed, owned, sent (narration carries the whole sequence)
const r3 = L('raj3').endFrame;
put('vo-whywait', r3 + 12);
put('vo-task', L('vo-whywait').endFrame + 12);
const tk = L('vo-task').startFrame;
E.lift = tk + 2; E.liftLand = E.lift + 56;
E.pickOpen = Math.max(E.liftLand + 16, tk + fr('vo-task', .62)); E.pickChoose = E.pickOpen + 26;
E.sendTap = Math.max(E.pickChoose + 30, tk + L('vo-task').durFrames + 4);
// Dispatch: the card shrinks into a task chip that flies into Raj's tile, the tile pulses with a "New task" note, then the cut to Raj's screen
E.glideStart = E.sendTap + 10; E.chipLand = E.glideStart + 36; E.rajGlow = E.chipLand - 2; E.taskIn = E.chipLand + 38;
put('vo-draft', E.taskIn + 40);
E.acceptTap = L('vo-draft').startFrame + 40; E.draftIn = E.acceptTap + 14;
E.editStart = Math.max(L('vo-draft').startFrame + fr('vo-draft', .52), E.draftIn + 36); E.editEnd = E.editStart + 50;
// vo-sent: "Raj approves." (the tap lands on it), then "Sent" 1.4 s in (the envelope leaves on it)
put('vo-sent', Math.max(L('vo-draft').endFrame + 14, E.editEnd + 30));
E.approveTap = L('vo-sent').startFrame + 8; E.foldStart = E.approveTap + 4; E.fly = L('vo-sent').startFrame + 40; E.flyEnd = E.fly + 34; E.sent = E.fly + 26;
E.s7End = Math.max(E.sent + 80, L('vo-sent').endFrame + 24);
// ---- S8 the quiet one
E.nudgeStart = E.s7End;
put('vo-nudge', E.nudgeStart + 14);
const nu = L('vo-nudge').startFrame;
E.hesitate = nu + fr('vo-nudge', .04); E.glow3 = nu + fr('vo-nudge', .53);
const ci0 = nu + fr('vo-nudge', .57); // the original card time: Aisha's own line is still timed from it
E.aishaLayout = E.glow3 + 4; E.catchupIn = E.aishaLayout + 56; // the tiles finish their move (54 f) before the card appears
E.nowRow = ci0 + 44; E.pointIn = ci0 + 84;
put('aisha2', Math.max(E.pointIn + 50, L('vo-nudge').endFrame + 30)); // the point is read (~1.5 s), then she speaks
E.unmute = L('aisha2').startFrame - 16; E.lean = L('aisha2').startFrame - 8;
E.catchupOut = L('aisha2').endFrame + 8;
put('mei-goodpoint', L('aisha2').endFrame + 16);
E.s8End = L('mei-goodpoint').endFrame + 40;
// ---- S9 tools
E.tools = E.s8End;
put('vo-tools', E.tools + 16);
const tv = L('vo-tools').startFrame;
// the four windows arrive on the spoken words "Chat... GitHub... calendar... wiki" (word onsets measured from the recording: 1.48, 2.22, 2.98, 3.78 s of 6.50 s)
E.toolWord = [.2277, .3415, .4585, .5815].map((q) => tv + fr('vo-tools', q));
E.toolArrive = E.toolWord.map((t) => t + 14);
E.s9End = tv + L('vo-tools').durFrames + 24;
// ---- S10 the call ends, minutes join the shelf
E.callEnd = E.s9End;
put('vo-end-minutes', E.callEnd + 20);
const ve = L('vo-end-minutes').startFrame;
E.endTap = ve + 14; E.confirmShow = E.endTap + 8; E.confirmTap = E.confirmShow + 34; E.dark = [0, 1, 2].map((i) => E.confirmTap + 8 + i * 12); E.ended = E.dark[2] + 14;
E.minutesIn = Math.max(E.ended + 6, ve + fr('vo-end-minutes', .34)); E.minutesTick = E.minutesIn + 18;
E.minutesApprove = ve + fr('vo-end-minutes', .775); E.published = E.minutesApprove + 12; E.wikiTap = E.published + 20; // Mei taps 'Open meeting minutes in Wiki', which is what opens the wiki
E.pullBack = E.published + 36; E.wikiSwap = E.pullBack + 4; E.pullBackEnd = E.pullBack + 45; E.wikiPush = E.pullBackEnd + 4; E.wikiPushEnd = E.wikiPush + 30;
E.rowIn = E.wikiPushEnd + 4; E.s10End = E.rowIn + 18 + 68;
// ---- S11 next Monday: the reminder pings on a beat, Mei opens the laptop, the call opens on the agenda line made from the calendar event
E.nextBuzz = snapUp(E.s10End + 24);
put('vo-next', E.nextBuzz + 10);
E.nextReach = E.nextBuzz + 50; E.nextLid = E.nextReach + 8; E.nextLidEnd = E.nextLid + 20; E.nextPush = E.nextLidEnd + 2; E.nextPushEnd = E.nextPush + 24;
put('mei-jade', Math.max(E.nextPushEnd + 24, L('vo-next').endFrame + 12));
put('raj-jade', L('mei-jade').endFrame + 12);
E.endCard = snapUp(L('raj-jade').endFrame + 45); // on a beat; FilmV10 starts the track late so its final downbeat lands here


lines.sort((a, b) => a.startFrame - b.startFrame);
for (const l of lines) {l.start = +(l.startFrame / fps).toFixed(4); l.end = +(l.endFrame / fps).toFixed(4);}
const gaps = lines.slice(1).map((l, i) => l.startFrame - lines[i].endFrame);
if (gaps.some((g) => g < 12)) throw new Error(`Speech gap below 12 f: ${JSON.stringify(gaps)}`);
if (L('raj-jade').endFrame > E.endCard) throw new Error('Narration runs into the end card');
const durationFrames = E.endCard + 150;

const sfxFiles = readdirSync(resolve(folder, 'sfx')).filter((f) => f.endsWith('.wav'));
const sfxFrames = Object.fromEntries(sfxFiles.map((f) => [f.replace('.wav', ''), Math.ceil(parseWav(readFileSync(resolve(folder, 'sfx', f))).seconds * fps) + 1]));
const timeline = {fps, width: 1920, height: 1080, bpm, beatPhaseSeconds: phase, durationFrames, durationSeconds: +(durationFrames / fps).toFixed(3), lines, events: E, sfxFrames, minGap: Math.min(...gaps)};
writeFileSync(resolve(folder, 'timeline.json'), `${JSON.stringify(timeline)}\n`);

const uri = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const hit = (() => {
  const sr = 24000, seconds = 0.65, n = Math.round(seconds * sr), out = Buffer.alloc(44 + n * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(n * 2, 40);
  let sd = 82913, low = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; const noise = sd / 2147483648 - 1; low += 0.17 * (noise - low);
    const val = Math.sin(2 * Math.PI * (58 * t + 4 * (1 - Math.exp(-35 * t)))) * Math.exp(-13 * t) * 0.65 + (noise - low) * Math.exp(-25 * t) * 0.18;
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, val)) * 32767), 44 + i * 2);
  }
  return out;
})();
const media = {
  voices: Object.fromEntries(order.map((id) => [id, uri('audio/wav', buffers[id])])),
  music: uri('audio/mpeg', readFileSync(resolve(folder, '../../audio/music/funk-joyful-rhythm-walk.mp3'))),
  ring: uri('audio/wav', readFileSync(resolve(folder, '../../audio/music/funk-joyful-rhythm-walk-ring.wav'))),
  cup: uri('image/svg+xml', readFileSync(resolve(repo, 'web/public/kaki-cup.svg'))),
  sfx: Object.fromEntries(sfxFiles.map((f) => [f.replace('.wav', ''), uri('audio/wav', readFileSync(resolve(folder, 'sfx', f)))])),
  endHit: uri('audio/wav', hit),
};
writeFileSync(resolve(folder, 'media.ts'), `// Generated by build-timeline.mjs. Original voice and music bytes are embedded unchanged.\nexport const media = ${JSON.stringify(media)};\nexport const voiceSources: Record<string, string> = media.voices;\nexport const sfxSources: Record<string, string> = media.sfx;\nexport const musicSrc = media.music;\nexport const cupSrc = media.cup;\nexport const ringSrc = media.ring;\nexport const endingSrc = media.endHit;\n`);
console.log(JSON.stringify({durationSeconds: timeline.durationSeconds, durationFrames, minGap: timeline.minGap, lines: lines.map((l) => [l.id, l.startFrame, l.endFrame]), events: E}));
