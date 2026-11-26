import React from 'react';
import {AbsoluteFill, Audio, Sequence, useCurrentFrame} from 'remotion';
import {fontFamily} from '../tokens';
import {C} from './primitives';
import {events as E, DURATION_FRAMES, FPS, HEIGHT, line, lines, sfxFrames, WIDTH} from './timeline';
import {camAt, CamKey, clamp01, easeCam, easeOut, mix, ramp, seg, settle, track} from './motion';
import {Rig} from './rig';
import {LAP_L, LAP_R, handTo, sigh} from './act';
import {EndCard, MinutesCard} from './cards';
import {Camera, KitchenShot, LAP, PUSH_SCALE, SCREEN_C, StreetShot, World, meiPt} from './world';
import {APP_BG, CallControls, CallScene, Caption, GRID, Tiles, layoutRects} from './stage';
import {endingSrc, musicSrc, ringSrc, sfxSources, voiceSources} from './media';
import {WikiScreenContent} from './wiki';
import {ToolsScene} from './tools';

const win = (f: number, a: number, b: number, n = 6) => ramp(f, a, a + n) * (1 - ramp(f, b - n, b));
const lerpLog = (a: number, b: number, t: number) => Math.exp(mix(Math.log(a), Math.log(b), t));
const WIDE: [number, number] = [960, 540];
/** Medium shot on Mei and the laptop: the desk calendar is outside this frame, so no sliver of it is ever cut by the edge. */
const MED: [number, number] = [810, 520], MED_S = 1.3;

/** Colour: the Monday world is washed out until the bridge, then warms. */
const warm = (f: number) => seg(f, E.warmStart, E.warmStart + 45);
const worldSat = (f: number) => f < E.warmStart ? .55 : mix(.55, 1, warm(f));
const grade = (f: number): React.CSSProperties => ({filter: `saturate(${worldSat(f)}) brightness(${mix(.96, 1, warm(f))})`});

// ---- the café shots (scene 1, scene 2, scene 11) --------------------------------------------------------------------
type Cafe = {buzz: number; phonePush: number; phonePushEnd: number; phoneBack: number; phoneBackEnd: number; sigh: number | null; mugDown: number; lookAt: number; zoom: boolean; reach: number; lidStart: number; lidEnd: number; pushStart: number; pushEnd: number; next: boolean};
const CAFE_A: Cafe = {buzz: E.buzz, phonePush: E.phonePush, phonePushEnd: E.phonePushEnd, phoneBack: E.phoneBack, phoneBackEnd: E.phoneBackEnd, sigh: E.sigh1, mugDown: E.mugDown, lookAt: E.phoneBackEnd + 60, zoom: true, reach: E.reach, lidStart: E.lidStart, lidEnd: E.lidEnd, pushStart: E.pushStart, pushEnd: E.pushEnd, next: false};
// Next Monday: the same café, the reminder pings, Mei smiles and opens the laptop straight away (no phone close-up).
const CAFE_D: Cafe = {buzz: E.nextBuzz, phonePush: 0, phonePushEnd: 0, phoneBack: 0, phoneBackEnd: E.nextBuzz + 14, sigh: null, mugDown: E.nextBuzz + 36, lookAt: E.nextReach - 40, zoom: false, reach: E.nextReach, lidStart: E.nextLid, lidEnd: E.nextLidEnd, pushStart: E.nextPush, pushEnd: E.nextPushEnd, next: true};

const cafeCam = (f: number, T: Cafe, from: number) => {
  const wide: CamKey[] = [[from, 960, 540, 1.0], ...(T.zoom ? [[T.phonePush, 960, 540, 1.0], [T.phonePushEnd, 480, 720, 2.2], [T.phoneBack, 480, 720, 2.2], [T.phoneBackEnd, 960, 540, 1.0]] as CamKey[] : []),
    [T.reach - 26, 960, 540, 1.0], [T.reach - 8, MED[0], MED[1], MED_S], [T.pushStart, MED[0], MED[1], MED_S]];
  if (f < T.pushStart) return camAt(f, wide);
  const p = seg(f, T.pushStart, T.pushEnd, easeCam);
  return {cx: mix(MED[0], SCREEN_C[0], p), cy: mix(MED[1], SCREEN_C[1], p), s: lerpLog(MED_S, PUSH_SCALE, p)};
};

const CafeShot: React.FC<{f: number; T: Cafe; from: number; screen: React.ReactNode}> = ({f, T, from, screen}) => {
  const lid = seg(f, T.lidStart, T.lidEnd, easeCam);
  // Mei's hand: holds the mug, sets it down (eased), lets go, then goes to the lid's top edge, lifts it with the lid and returns
  const mugHand = seg(f, T.mugDown, T.mugDown + 20, easeCam), release = seg(f, T.mugDown + 16, T.mugDown + 34, easeCam);
  const reach = seg(f, T.reach, T.lidStart + 2, easeCam) * (1 - seg(f, T.lidEnd + 4, T.lidEnd + 24, easeCam));
  const buzzAge = f - T.buzz;
  const look = seg(f, T.buzz + 6, T.buzz + 14), unlook = seg(f, T.phoneBackEnd, T.phoneBackEnd + 24);
  const s = T.sigh == null ? {breath: 0, shoulder: 0, brow: 0} : sigh(f, T.sigh);
  const atLaptop = seg(f, T.lookAt, T.reach - 6);
  const rig: Rig = {
    breath: Math.sin(f / 26) * .8 + s.breath, shoulder: s.shoulder * 1.8, brow: s.brow * 1.6, puff: T.sigh != null && f >= T.sigh + 4 && f < T.sigh + 34 ? (f - T.sigh - 4) / 30 : 0,
    blink: T.sigh != null && f >= T.sigh + 12 && f < T.sigh + 40 ? 1 : undefined,
    gy: T.next ? mix(.7 * look, .5, atLaptop) * (1 - .3 * unlook) : mix(.8 * look * (1 - .7 * unlook), .5, atLaptop), gx: mix(0, .9, atLaptop),
    tilt: T.next ? mix(mix(0, -3, seg(f, T.buzz + 18, T.buzz + 34)), 3, atLaptop) : mix(4 * look * (1 - .5 * unlook), 3, atLaptop),
    mouth: T.next ? (f >= T.buzz + 20 ? 'smile' : 'flat') : f >= T.buzz + 14 ? 'frown' : 'flat',
  };
  if (T.next && f >= T.buzz + 6) rig.brow = .3 * seg(f, T.buzz + 8, T.buzz + 20);
  const cam = cafeCam(f, T, from);
  const lit = seg(f, T.buzz, T.buzz + 4) * (1 - seg(f, T.mugDown + 10, T.mugDown + 40));
  const light = T.next ? 1 : 0;
  return <Camera cx={cam.cx} cy={cam.cy} s={cam.s}>
    <World f={f} light={light} lid={lid} screen={screen} screenOn={seg(f, T.lidStart, T.lidStart + 8)} mei={rig} phoneBuzz={buzzAge >= 0 && buzzAge < 40 ? T.buzz : undefined} phoneLit={lit}
      tear={T.next ? [1, 0, 0, 0] : undefined} phoneShow={f < T.mugDown + 70} mugHand={mugHand} release={release} reach={reach}/>
  </Camera>;
};

// ---- call frame used both full-screen and inside the laptop --------------------------------------------------------
const CallFrame: React.FC<{f: number; cups: boolean}> = ({f, cups}) => <AbsoluteFill style={{background: APP_BG, fontFamily, color: C.pearl}}><Tiles f={f} cups={cups} rects={GRID}/><CallControls/></AbsoluteFill>;

/** Next Monday's call: it opens with the agenda line Jade Packaging, imported from the calendar event made in this meeting. */
const ReunionScreen: React.FC<{f: number}> = ({f}) => <AbsoluteFill style={{background: APP_BG, fontFamily, color: C.pearl}}>
  <div style={{position: 'absolute', left: 100, top: 40, display: 'flex', alignItems: 'center', gap: 22, padding: '14px 28px', borderRadius: 18, background: '#ffffff14', border: '1px solid #ffffff30', fontSize: 36}}>
    <span style={{color: '#a9c0b9', fontWeight: 650}}>Agenda</span><span style={{fontWeight: 760}}>Jade Packaging</span>
    <span style={{fontSize: 24, fontWeight: 700, color: '#0d1117', background: '#ffd28a', borderRadius: 10, padding: '4px 14px'}}>From calendar</span>
  </div>
  <Tiles f={f} cups rects={GRID}/><CallControls/>
</AbsoluteFill>;

const SceneOpen: React.FC<{f: number}> = ({f}) => {
  const rajShot = f >= E.rajShot && f < E.aishaShot ? 1 : 0, streetShot = f >= E.aishaShot && f < E.meiShot4 ? 1 : 0; // quick hard cuts
  const grn = line('raj-groan'), gz = f >= grn.startFrame && f < grn.endFrame;
  const rajRig: Rig = {blink: gz ? 1 : undefined, wide: 0, puff: 0,gx: track(f, [[E.rajShot + 12, 0], [E.rajShot + 22, 1.6]]), gy: track(f, [[E.rajShot + 12, 0], [E.rajShot + 22, -1.3]]), brow: track(f, [[E.rajShot + 24, 0], [E.rajShot + 34, -.5]]), tilt: track(f, [[E.rajShot + 22, 0], [E.rajShot + 34, -8]]), mouth: gz ? 'open' : 'flat', shoulder: track(f, [[E.rajShot + 30, 0], [E.rajShot + 60, 7]]), breath: Math.sin(f / 22) * .8, pose: 'clip'};
  // Aisha, on the phone, hears "Monday": a slow eye-roll, a slump, a hand to her brow
  const A0 = E.aishaShot;
  const aishaRig: Rig = {tilt: -9 + Math.sin(f / 5) * .4, brow: track(f, [[A0 + 20, -.3], [A0 + 36, -.7]]), shoulder: track(f, [[A0 + 28, 0], [A0 + 50, 5]]),
    gx: track(f, [[A0 + 22, 0], [A0 + 30, 1.3], [A0 + 40, -1.3], [A0 + 50, 0]]), gy: track(f, [[A0 + 10, 0], [A0 + 18, .9], [A0 + 24, .9], [A0 + 30, -1.5], [A0 + 42, -1.5], [A0 + 52, .6]]),
    limbR: handTo(f, A0 + 30, A0 + 46, A0 + 200, A0 + 220, LAP_R, [[372, 480], [470, 380], [345, 262]]), mouth: 'flat', pose: 'ear', breath: Math.sin(f / 22) * .8};
  const kit = cameraGlide(f, E.rajShot), str = cameraGlide(f, E.aishaShot);
  return <>
    <CafeShot f={f} T={CAFE_A} from={0} screen={<CallFrame f={f} cups={false}/>}/>
    {rajShot > 0 && <AbsoluteFill><Camera cx={1000} cy={400} s={1.35 + kit - 1}><KitchenShot f={f} rig={rajRig}/></Camera></AbsoluteFill>}
    {streetShot > 0 && <AbsoluteFill><Camera cx={WIDE[0]} cy={WIDE[1]} s={str}><StreetShot f={f} rig={{...aishaRig, pose: 'ear'}}/></Camera></AbsoluteFill>}
  </>;
};
const cameraGlide = (_f: number, _at: number) => 1;

// ---- scene 4/5: week after week, the cost, the rewind --------------------------------------------------------------
const SceneCost: React.FC<{f: number}> = ({f}) => {
  const r = E.rewind;
  // the rewind plays each page and its sticky note back together, eased, one after another
  const tear = [0, 1, 2, 3].map((i) => f < r ? seg(f, E.tears[i], E.tears[i] + 18) : 1 - seg(f, E.rewindPages[3 - i], E.rewindPages[3 - i] + 22));
  const notes = [0, 1, 2, 3].map((i) => f < r ? seg(f, E.stickies[i], E.stickies[i] + 8) : 1 - seg(f, E.rewindPages[3 - i], E.rewindPages[3 - i] + 22));
  const x = f < r ? seg(f, E.envIn, E.envIn + 20, easeOut) : 1 - seg(f, r + 18, r + 38);
  const flap = f < r ? 170 * seg(f, E.flapOpen, E.flapOpen + 10) : 170 * (1 - seg(f, r + 12, r + 22));
  const letter = f < r ? seg(f, E.letterUp, E.letterUp + 14) : 1 - seg(f, r + 4, r + 14);
  const blur = 3 * (1 - seg(f, E.faceIn, E.faceIn + 20)) * seg(f, E.pullEnd - 6, E.pullEnd + 6) * (f < r ? 1 : 0);
  const face = seg(f, E.faceFace, E.faceFace + 14), slowBlink = f >= E.faceFace + 10 && f < E.faceFace + 18 ? Math.sin(Math.PI * (f - E.faceFace - 10) / 8) : 0;
  // Mei is in shocked dismay at the letter: eyes wide, brows right up, a small open 'o' mouth, a hand to her forehead; it goes straight to a smile when the first cup lands (no neutral face in between). She only smiles once the first cup lands.
  const happy = seg(f, E.cup[0], E.cup[0] + 8), dis = seg(f, E.letterPush, E.letterPush + 18);
  const rig: Rig = {
    breath: Math.sin(f / 26) * .8, shoulder: (2 - 5 * dis) * (1 - happy) - 2 * happy, gx: mix(.6, .2, face) * (1 - happy), gy: mix(.3, .6, face) * (1 - happy),
    tilt: mix(2, 3, face) * (1 - happy), brow: 1.15 * dis * (1 - happy) + .3 * happy, browIn: .3 * dis * (1 - happy), wide: 1.5 * dis * (1 - happy), mouth: happy > .5 ? 'smile' : dis > .3 ? 'o' : 'flat', blink: slowBlink > 0 ? slowBlink : undefined,
    limbL: handTo(f, E.letterPush + 12, E.letterPush + 30, E.rewind - 4, E.rewind + 10, LAP_L, [[223, 476], [115, 560], [236, 258]]),
  };
  // camera
  let cam;
  if (f < E.pullEnd) {const p = seg(f, E.pullStart, E.pullEnd, easeCam); cam = {cx: mix(SCREEN_C[0], WIDE[0], p), cy: mix(SCREEN_C[1], WIDE[1], p), s: lerpLog(PUSH_SCALE, 1, p)};}
  else if (f < E.push2Start) cam = camAt(f, [[E.pullEnd, 960, 540, 1.0], [E.letterPush - 6, 960, 540, 1.0], [E.letterPush + 30, 700, 690, 1.6], [E.faceIn, 700, 690, 1.6], [E.faceFace, 585, 355, 2.3], [r, 585, 355, 2.3], [r + 34, 960, 540, 1.0], [E.push2Start, 960, 540, 1.0]]);
  else {const p = seg(f, E.push2Start, E.push2End, easeCam); cam = {cx: mix(960, SCREEN_C[0], p), cy: mix(540, SCREEN_C[1], p), s: lerpLog(1.0, PUSH_SCALE, p)};}
  return <Camera cx={cam.cx} cy={cam.cy} s={cam.s}>
    <World f={f} light={warm(f)} lid={1} screen={<CallFrame f={f} cups={false}/>} screenOn={1} mei={rig} meiBlur={blur} phoneShow={false} phoneLit={0} tear={tear} rewind={f >= r} notes={notes}
      env={{x, flapDeg: flap, letter, show: x > 0 && x <= 1 && f >= E.envIn - 1}}/>
  </Camera>;
};

// ---- scene 10: minutes join the shelf --------------------------------------------------------------------------------
const MINUTES_SLOT = {left: 360, top: 170, width: 1200, height: 600};
const confirmOn = (f: number) => f >= E.confirmShow && f < E.confirmTap + 8;
const MinutesScreenContent: React.FC<{f: number}> = ({f}) => {
  const card = ramp(f, E.minutesIn, E.minutesIn + 14), dlg = ramp(f, E.confirmShow, E.confirmShow + 8) * (1 - ramp(f, E.confirmTap + 4, E.confirmTap + 10));
  return <AbsoluteFill style={{background: APP_BG, fontFamily, color: C.pearl}}>
    <Tiles f={f} cups rects={GRID} dark={E.dark}/>
    <CallControls f={f} ended={f >= E.ended}/>
    {dlg > 0 && <div style={{position: 'absolute', left: 660, top: 330, width: 600, padding: '34px 40px', borderRadius: 24, background: '#f4f8f6', color: C.ink, boxShadow: '0 30px 80px #000b', opacity: dlg, transform: `translateY(${(1 - dlg) * 14}px)`}}>
      <div style={{fontSize: 38, fontWeight: 760, letterSpacing: '-.02em'}}>End meeting for everyone?</div>
      <div style={{display: 'flex', gap: 16, justifyContent: 'flex-end', marginTop: 34}}>
        <div style={{padding: '14px 26px', borderRadius: 14, background: '#e0ebe5', fontSize: 27, fontWeight: 700, color: C.teal}}>Cancel</div>
        <div style={{position: 'relative', padding: '14px 26px', borderRadius: 14, background: '#a9463b', fontSize: 27, fontWeight: 700, color: '#fff', transform: `scale(${f >= E.confirmTap && f < E.confirmTap + 6 ? .94 : 1})`}}>End the meeting{f >= E.confirmTap && f < E.confirmTap + 20 && <span style={{position: 'absolute', inset: -8 - (f - E.confirmTap), border: '4px solid #efb96d', borderRadius: 22, opacity: 1 - (f - E.confirmTap) / 20}}/>}</div>
      </div>
    </div>}
    {f >= E.minutesIn - 10 && <div style={{position: 'absolute', inset: 0, background: '#0b0f14', opacity: .6 * ramp(f, E.minutesIn - 10, E.minutesIn)}}/>}
    {f >= E.minutesIn && <div style={{position: 'absolute', ...MINUTES_SLOT, opacity: card}}><MinutesCard f={f}/></div>}
  </AbsoluteFill>;
};
const MinutesAndWiki: React.FC<{f: number}> = ({f}) => {
  // one screen after the other (never both at once): the minutes fade out, then the wiki fades in
  const into = seg(f, E.wikiSwap + 8, E.wikiSwap + 22);
  const content = <>{into < 1 && <div style={{position: 'absolute', inset: 0}}><MinutesScreenContent f={f}/></div>}{into > 0 && <div style={{position: 'absolute', inset: 0, opacity: into}}><WikiScreenContent f={f}/></div>}</>;
  const p = seg(f, E.pullBack, E.pullBackEnd, easeCam), q = seg(f, E.wikiPush, E.wikiPushEnd, easeCam);
  const cam = f < E.wikiPush ? {cx: mix(SCREEN_C[0], MED[0], p), cy: mix(SCREEN_C[1], MED[1], p), s: lerpLog(PUSH_SCALE, MED_S, p)}
    : {cx: mix(MED[0], SCREEN_C[0], q), cy: mix(MED[1], SCREEN_C[1], q), s: lerpLog(MED_S, PUSH_SCALE, q)};
  const rig: Rig = {breath: Math.sin(f / 26) * .8, shoulder: -2, mouth: 'smile', gx: .8, gy: .3, tilt: 2, brow: .2};
  return <Camera cx={cam.cx} cy={cam.cy} s={cam.s}>
    <World f={f} light={1} lid={1} screen={content} screenOn={1} mei={rig} phoneShow={false} phoneLit={0}/>
  </Camera>;
};

// ---- audio ---------------------------------------------------------------------------------------------------------------
// The bed is the track at 115.02 bpm (a bar is 4 beats). The film's end card sits on a bar line; the track's own final downbeat (its bar 64)
// is placed exactly there by one phrase-aligned jump back, and its ring-out (funk-joyful-rhythm-walk-ring.wav) carries on under the end card.
const BAR = 4 * 60 / 115.02 * FPS;
const barFrame = (i: number) => Math.round((.03 + i * 4 * 60 / 115.02) * FPS);
// The track starts OFF frames in (whole beats, so beat-snapped cues stay on the beat) and jumps back JUMP bars (whole phrases) at its bar 16,
// so that its bar 64 (the final downbeat) lands on the end card. Any beat-aligned end card works.
const JUMP = (() => {let j = 0; while (barFrame(64 + j) < E.endCard) j += 4; return j;})();
const OFF = barFrame(64 + JUMP) - E.endCard, T_SEAM = barFrame(16) - OFF, TRIM_B = barFrame(16 - JUMP);
if (Math.abs(Math.round(OFF / (60 / 115.02 * FPS)) * (60 / 115.02 * FPS) - OFF) > 1 || TRIM_B < 0 || T_SEAM < E.buzz + 200) throw new Error(`Music cannot meet the end card (frame ${E.endCard}): OFF ${OFF}, JUMP ${JUMP}`);
const MASTER = .4;
const level = (f: number) => track(f, [[0, 0], [E.buzz, 0], [E.buzz + 125, .6], [E.gridIn, .6], [E.gridIn + 125, 1], [E.faceIn, 1], [E.faceIn + 20, .3], [E.rewind + 4, .3], [E.rewind + 40, 1]], (t) => t);
const duck = (f: number): number => {
  let g = 1;
  for (const l of lines) g = Math.min(g, 1 - .7 * clamp01(Math.min(ramp(f, l.startFrame - 6, l.startFrame), 1 - ramp(f, l.endFrame, l.endFrame + 10))));
  const sil = ramp(f, E.silenceStart, E.silenceStart + 10) * (1 - ramp(f, line('mei-later').startFrame - 10, line('mei-later').startFrame));
  return Math.min(g, 1 - .65 * sil);
};
const bed = (f: number) => MASTER * level(f) * duck(f);
const RING_AT = E.endCard - 3;
const SWELL = 1.6; // the bed rises over the last ~1.5 s into the final downbeat
const swell = (f: number) => 1 + (SWELL - 1) * seg(f, E.endCard - 48, RING_AT, (t) => t * t); // the ring file starts 3 frames (0.1 s) before the final downbeat, identical to the bed there, so the hand-over cannot be heard
const musicA = (f: number) => bed(f) * (1 - ramp(f, T_SEAM, T_SEAM + Math.round(BAR)));
const musicB = (f: number) => bed(f) * swell(f) * ramp(f, T_SEAM, T_SEAM + Math.round(BAR)) * (1 - ramp(f, RING_AT, E.endCard + 1));

/** The call hands over to the tools while "And not just email" is spoken; each window then arrives on its own word. */
const TOOLS_AT = E.toolWord[0] - 14;
const mo = line('mei-moveon'), ml = line('mei-later');
const SFX: [number, string][] = [
  [E.buzz, 'buzz'], [E.mugDown + 16, 'mug'], [E.lidStart, 'creak'],
  [E.sigh1 + 2, 'mei-sigh'], [E.sigh1 + 8, 'puff'], 
  [E.stepOut, 'murmur'],
  ...E.tears.map((t, i): [number, string] => [t, `rip${i}`]), ...E.stickies.map((t): [number, string] => [t, 'sticky']),
  [E.envIn + 2, 'slide'], [E.envIn + 22, 'thud'], [E.flapOpen, 'flap'],
  [E.rewind + 14, 'flutter'], [E.grid2 - 2, 'join'],
  ...E.cup.map((t): [number, string] => [t + 4, 'tok']),
  [E.answerGlow, 'glint'], [E.glow3, 'glint'], [E.rajGlow, 'glint'],
  ...[E.answerIn, E.catchupIn, E.lift, E.taskIn, E.draftIn, E.minutesIn].map((t): [number, string] => [t, 'card']),
  [E.glideStart, 'whoosh1'],
  [E.sendTap, 'click'], [E.acceptTap, 'click'], [E.approveTap, 'click'], [E.minutesApprove, 'click'], [E.wikiTap, 'click'], [E.unmute, 'click'], [E.endTap, 'click'], [E.confirmTap, 'click'],
  [E.editStart, 'typing'],
  [E.foldStart + 26, 'crease'], [E.foldStart + 40, 'crease'], [E.fly + 2, 'whoosh0'], [E.sent, 'sent'],
  ...E.toolWord.map((t): [number, string] => [t - 3, 'card']), ...E.toolArrive.map((t): [number, string] => [t, 'settle']),
  ...E.dark.map((t): [number, string] => [t, 'off']),
  [E.minutesTick, 'settle'], [E.rowIn + 14, 'settle'],
  [E.nextBuzz, 'buzz'], [CAFE_D.mugDown + 16, 'mug'], [E.nextLid, 'creak'],
];
const ROOM: number[] = [];
for (let t = 0; t < E.rewind + 40; t += 360) ROOM.push(t);
const ROOM2: number[] = [];
for (let t = E.s10End - 40; t < E.endCard; t += 360) ROOM2.push(t);

export const FilmV10: React.FC = () => {
  const f = useCurrentFrame();
  // the call stage hands over to the tools windows by a slow overlap (no empty screen between them)
  const stageVis = Math.max(win(f, E.gridIn - 4, E.pullStart + 4, 4), ramp(f, E.grid2 - 4, E.grid2 + 2) * (1 - ramp(f, TOOLS_AT - 8, TOOLS_AT + 16)));
  const worldA = f < E.gridIn + 2;
  const worldB = f >= E.pullStart - 1 && f < E.grid2 + 3;
  const worldC = f >= E.pullBack && f < E.s10End + 2;
  const worldD = f >= E.s10End;
  const sat = worldSat(f);
  return <AbsoluteFill style={{fontFamily, color: C.pearl, background: APP_BG, overflow: 'hidden'}}>
    {worldA && <AbsoluteFill style={grade(f)}><SceneOpen f={f}/></AbsoluteFill>}
    {worldB && <AbsoluteFill style={grade(f)}><SceneCost f={f}/></AbsoluteFill>}
    {worldC && <AbsoluteFill style={{opacity: 1 - ramp(f, E.s10End - 10, E.s10End + 2)}}><MinutesAndWiki f={f}/></AbsoluteFill>}
    {worldD && <AbsoluteFill style={{opacity: ramp(f, E.s10End + 2, E.s10End + 16)}}><CafeShot f={f} T={CAFE_D} from={E.nextBuzz - 24} screen={<ReunionScreen f={f}/>}/></AbsoluteFill>}
    {stageVis > 0 && <AbsoluteFill style={{opacity: stageVis, filter: `saturate(${sat})`}}>
      <Camera {...stageCam(f)}><CallScene f={f} cups={f >= E.grid2}/></Camera>
    </AbsoluteFill>}
    {f >= TOOLS_AT - 10 && f < E.callEnd && <AbsoluteFill style={{opacity: ramp(f, TOOLS_AT - 10, TOOLS_AT + 14), background: APP_BG}}><ToolsScene f={f}/></AbsoluteFill>}
    {f >= E.callEnd && f < E.pullBack && <MinutesScreenContent f={f}/>}
    {/* the end card: the scene goes to black first, then the logo comes up on black */}
    {f >= E.endCard - 18 && <AbsoluteFill style={{background: '#0d1117', opacity: ramp(f, E.endCard - 18, E.endCard - 2)}}/>}
    
    <Caption f={f}/>
    {f >= E.endCard && <EndCard f={f}/>}
    {lines.map((l) => <Sequence key={l.id} from={l.startFrame} durationInFrames={l.endFrame - l.startFrame} name={`voice-${l.id}`}><Audio src={voiceSources[l.id]} volume={1}/></Sequence>)}
    <Sequence from={0} durationInFrames={T_SEAM + Math.round(BAR)} name="funk-bed"><Audio src={musicSrc} trimBefore={OFF} volume={musicA}/></Sequence>
    <Sequence from={T_SEAM} durationInFrames={E.endCard + 1 - T_SEAM} name="funk-bed-second-pass"><Audio src={musicSrc} trimBefore={TRIM_B} volume={(g) => musicB(g + T_SEAM)}/></Sequence>
    <Sequence from={RING_AT} durationInFrames={DURATION_FRAMES - RING_AT} name="funk-final-hit-and-ring"><Audio src={ringSrc} volume={(g) => MASTER * SWELL * ramp(g + RING_AT, RING_AT, E.endCard + 1)}/></Sequence>
    {ROOM.map((t) => <Sequence key={`r${t}`} from={t} durationInFrames={Math.min(360, E.rewind + 40 - t)} name="room-tone"><Audio src={sfxSources.roomtone} volume={(g) => 1 - ramp(g + t, E.rewind + 10, E.rewind + 40)}/></Sequence>)}
    {ROOM2.map((t) => <Sequence key={`q${t}`} from={t} durationInFrames={360} name="room-tone-2"><Audio src={sfxSources.roomtone} volume={(g) => ramp(g + t, E.s10End - 40, E.s10End - 10) * (1 - ramp(g + t, E.nextPushEnd, E.nextPushEnd + 30))}/></Sequence>)}
    {SFX.map(([at, name], i) => <Sequence key={i} from={at} durationInFrames={sfxFrames[name]} name={`sfx-${name}`}><Audio src={sfxSources[name]} volume={1}/></Sequence>)}
    <Sequence from={E.endCard} durationInFrames={20} name="end-card-boom"><Audio src={endingSrc} volume={.3}/></Sequence>
  </AbsoluteFill>;
};

// ---- stage camera over the call: static wide; the only move is the motivated push on Mei while she waits in silence ----
const stageKeys: CamKey[] = [
  [E.gridIn, 960, 540, 1], [E.silenceStart + 20, 960, 540, 1], [E.silenceStart + 62, 960, 500, 1.04], [line('mei-later').endFrame + 4, 960, 500, 1.04], [line('aisha1').startFrame - 8, 960, 540, 1],
];
const stageCam = (f: number) => camAt(f, stageKeys);

export const FilmV10Meta = {fps: FPS, width: WIDTH, height: HEIGHT, durationInFrames: DURATION_FRAMES};
void LAP; void meiPt; void settle;
