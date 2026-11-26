// Acting tracks: every gesture is keyed to the timeline so glances, sighs and shrugs land on the dialogue.
import {events as E, line} from './timeline';
import {easeIn, easeOut, mix, seg, track} from './motion';
import {Limb, Mouth, Rig, talkMouth} from './rig';

export type Sigh = {breath: number; shoulder: number; brow: number};
/** Breath rises 3 px, falls to +2 px with the shoulders 4 px lower and the brows down: it ends lower than it started. */
export const sigh = (f: number, s: number): Sigh => {
  if (f < s) return {breath: 0, shoulder: 0, brow: 0};
  const up = seg(f, s, s + 14, easeOut), down = seg(f, s + 14, s + 36, easeIn), k = seg(f, s + 14, s + 36);
  const breath = f < s + 14 ? -3 * up : f < s + 36 ? mix(-3, 2, down) : 2 * (1 - seg(f, s + 36, s + 100));
  return {breath, shoulder: 4 * k, brow: -.3 * k * (1 - seg(f, s + 60, s + 100))};
};
const idle = (f: number, who: number) => Math.sin(f / 26 + who * 2) * .8;
const pulse = (f: number, at: number, n: number, amp: number) => f >= at && f < at + n ? amp * Math.sin(Math.PI * (f - at) / n) : 0;

const puffOf = (f: number, at: number, n = 30) => f >= at && f < at + n ? (f - at) / n : 0;

type Pts = [number, number][];
/** A hand that rises from the lap to a spot on the head and goes back down: one eased up, one eased down, no jitter. */
export const handTo = (f: number, up0: number, up1: number, down0: number, down1: number, rest: Pts, top: Pts, wobble = 0): Limb | undefined => {
  const k = seg(f, up0, up1, easeOut) * (1 - seg(f, down0, down1));
  if (k <= 0) return undefined;
  const w = wobble * k * Math.sin((f - up1) / 7);
  return {pts: rest.map((p, i): [number, number] => [mix(p[0], top[i][0], k) + (i === rest.length - 1 ? w : 0), mix(p[1], top[i][1], k) + (i === rest.length - 1 ? w * .6 : 0)]), a: Math.min(1, k * 4)};
};
export const LAP_L: Pts = [[221, 480], [165, 640], [215, 745]];
export const LAP_R: Pts = [[372, 480], [450, 640], [395, 745]];
const RAJ_HEAD: Pts = [[372, 470], [505, 350], [402, 190]];
const AISHA_CHEEK: Pts = [[221, 480], [130, 600], [205, 392]];

/** Ground rig for a person on the call at frame f (call tiles, S3 onwards). */
export const gridRig = (who: number, f: number): Rig => {
  const r: Rig = {breath: idle(f, who)};
  const m1 = line('mei1'), r1 = line('raj1'), m2 = line('mei2'), ml = line('mei-later'), a1 = line('aisha1'), mo = line('mei-moveon');
  const afterBridge = f >= E.grid2;
  const a2 = line('aisha2'), gp = line('mei-goodpoint');
  const cupLanded = f >= E.cup[who];
  // sad until the cup lands, then straight to a smile: no neutral face in between
  const calm: Mouth = afterBridge ? (cupLanded ? 'smile' : 'frown') : who === 1 && f >= r1.startFrame - 10 ? 'frown' : 'flat';
  const voice = (['mei', 'raj', 'aisha'] as const)[who];
  r.mouth = talkMouth(f, who, voice, calm);
  if (who === 0) {
    if (!afterBridge) {
      const s = sigh(f, ml.startFrame), s2 = sigh(f, mo.startFrame + 2);
      r.shoulder = 2 + s.shoulder + (f >= mo.startFrame ? 1.5 * s2.shoulder : 0); r.breath = (r.breath ?? 0) + s.breath + s2.breath;
      // more tense beat by beat: worried at her question, brows pull down in the silence, resigned when she gives up
      r.brow = track(f, [[m1.startFrame, 0], [m2.startFrame, -.25], [E.silenceStart + 30, -.5], [mo.startFrame, -.6], [E.rub, -.75]]) + s.brow + s2.brow * 1.4;
      r.tilt = f >= m1.startFrame && f < m1.endFrame ? 2 : 0;
      r.gy = track(f, [[ml.startFrame + 14, 0], [ml.startFrame + 28, .7], [ml.startFrame + 46, .7], [ml.startFrame + 60, 0]]);
      r.puff = Math.max(puffOf(f, ml.startFrame + 6), puffOf(f, mo.startFrame + 4));
      if (f >= mo.startFrame && f < mo.startFrame + 30) {r.blink = f >= mo.startFrame + 2 && f < mo.startFrame + 14 ? 1 : undefined; r.tilt = 4;}
      const rub = seg(f, E.rub, E.rub + 8);
      const away = 1 - seg(f, E.rub + 38, E.rub + 48);
      if (rub * away > 0) {
        const j = Math.sin((f - E.rub) / 30 * Math.PI * 6) * 3;
        r.limbL = {pts: [[223, 476], [118, 578], [176 + j, 340 + j]], a: rub * away};
        r.blink = f >= E.rub + 8 && f < E.rub + 38 ? 1 : undefined;
        r.brow = -.7; r.tilt = 4; r.mouth = 'frown';
      }
      if (f >= m2.endFrame - 20 && r.mouth === 'flat') r.mouth = 'frown';
    } else {
      r.shoulder = -2;
      r.brow = cupLanded ? .3 : -.45;
      const ans = f >= E.answerLayout && f < line('raj2').startFrame;
      r.gx = ans ? .6 : 0;
      if (f >= E.lift && f < E.glideStart) {r.gx = .7; r.armR = pulse(f, E.sendTap - 2, 10, 7); r.tilt = pulse(f, E.sendTap - 2, 14, 2);}
      if (f >= E.glideStart && f < E.taskIn + 20) {r.gx = .5; r.mouth = 'smile';}
      if (f >= gp.startFrame - 6 && f < gp.endFrame + 30) {r.tilt = pulse(f, gp.startFrame, 12, 3) + pulse(f, gp.startFrame + 20, 12, 3); r.brow = .3;}
      if (f >= gp.endFrame && f < E.s8End) r.mouth = 'smile';
      if (f >= E.endTap - 4 && f < E.endTap + 8) r.armR = pulse(f, E.endTap - 4, 12, 7);
      if (f >= E.confirmTap - 4 && f < E.confirmTap + 8) r.armR = pulse(f, E.confirmTap - 4, 12, 7);
      if (f >= E.ended) {r.mouth = 'smile'; r.shoulder = -3;}
    }
  }
  if (who === 1) {
    if (!afterBridge) {
      // "Uh... let me check": scratches his head, picks up the phone, scrolls and frowns; in the silence he puts it down and scratches again
      r.brow = track(f, [[r1.startFrame, 0], [r1.startFrame + 10, -.2], [E.silenceStart + 20, -.25], [E.rajRoll, -.25], [E.rajRoll + 12, -.35]]);
      r.browIn = track(f, [[r1.startFrame, 0], [r1.startFrame + 14, .7]]);
      r.shoulder = pulse(f, r1.startFrame + 30, 16, -5);
      r.phoneUp = seg(f, r1.startFrame + 46, r1.startFrame + 60, easeOut) * (1 - seg(f, E.silenceStart + 4, E.silenceStart + 20));
      r.phoneScroll = Math.max(0, f - (r1.startFrame + 60)) * 1.6;
      r.gy = f >= r1.startFrame + 50 ? .8 : 0;
      r.gx = f >= E.silenceStart + 6 ? track(f, [[E.silenceStart + 6, 0], [E.silenceStart + 16, 1]]) : 0;
      if (f >= E.silenceStart + 6) r.gy = .1;
      if (f >= r1.startFrame + 54 && f < E.silenceStart + 20 && r.mouth === 'flat') r.mouth = 'frown';
      r.limbR = handTo(f, r1.startFrame + 4, r1.startFrame + 18, r1.startFrame + 40, r1.startFrame + 54, LAP_R, RAJ_HEAD, 7)
        ?? handTo(f, E.silenceStart + 22, E.silenceStart + 36, E.silenceStart + 66, E.silenceStart + 80, LAP_R, RAJ_HEAD, 7);
      // annoyed eye-roll and exhale after Mei gives up
      if (f >= E.rajRoll && f < E.rajRoll + 70) {
        r.gx = track(f, [[E.rajRoll, 1], [E.rajRoll + 10, -1.5], [E.rajRoll + 22, 1.2], [E.rajRoll + 34, 0]]);
        r.gy = track(f, [[E.rajRoll, .1], [E.rajRoll + 10, -1.5], [E.rajRoll + 34, .3]]);
        r.tilt = track(f, [[E.rajRoll, 0], [E.rajRoll + 12, -6], [E.rajRoll + 40, -6], [E.rajRoll + 60, 0]]);
        r.shoulder = 4 * seg(f, E.rajRoll + 24, E.rajRoll + 40);
        r.mouth = 'frown'; r.puff = puffOf(f, E.rajRoll + 26);
      }
      if (f >= E.rajRoll + 56) r.brow = -.35;
    } else {
      r.shoulder = -2;
      r.brow = cupLanded ? .3 : -.45;
      const wy = line('vo-whywait'), tk = line('vo-task');
      if (f >= E.answerIn - 4 && f < E.answerOut) {
        r.gx = track(f, [[E.answerIn + 2, 0], [E.answerIn + 14, .8]]);
        r.brow = track(f, [[E.answerIn + 10, 0], [E.answerIn + 22, .5], [E.answerIn + 70, .5], [E.answerIn + 90, 0]]);
        r.wide = track(f, [[E.answerIn + 10, 0], [E.answerIn + 22, .5], [E.answerIn + 70, .5], [E.answerIn + 90, 0]]);
        if (f >= E.answerIn + 70) {r.shoulder = 4; r.tilt = pulse(f, E.answerIn + 82, 14, 4);}
      }
      if (f >= line('raj2').startFrame - 8 && f < line('raj2').endFrame) {r.gx = 0; r.mouth = talkMouth(f, 1, 'raj', 'smile');}
      if (f >= wy.startFrame && f < tk.startFrame) {r.wide = .5; r.brow = .5; r.gx = -.4;}
      if (f >= tk.startFrame && f < E.rajGlow) {r.gx = -.5; r.mouth = 'smile';}
      if (f >= E.rajGlow && f < E.draftIn) {r.gx = track(f, [[E.rajGlow, -.3], [E.rajGlow + 16, .8]]); r.brow = .5; r.wide = .4;}
      if (f >= E.draftIn && f < E.editEnd + 10) r.gx = .5;
      if (f >= E.editStart && f < E.editEnd) r.tilt = Math.sin(f / 3) * 1.8;
      if (f >= E.approveTap && f < E.s7End) {r.mouth = 'smile'; r.gx = 0; r.shoulder = 0;}
      if (f >= gp.startFrame && f < E.s8End) {r.mouth = 'smile'; r.tilt = pulse(f, gp.startFrame + 6, 14, 3);}
    }
  }
  if (who === 2) {
    if (!afterBridge) {
      r.gx = track(f, [[m1.startFrame + 40, 0], [m1.startFrame + 90, -.9]]);
      r.tilt = track(f, [[m1.startFrame + 40, 0], [m1.startFrame + 90, -5]]);
      r.brow = -.15;
      r.gy = track(f, [[E.silenceStart + 14, 0], [E.silenceStart + 24, .8], [E.stepBack - 10, .8], [E.stepBack + 6, 0]]);
      if (f >= E.stepBack - 6) {r.gx = track(f, [[E.stepBack - 6, -.9], [E.stepBack + 14, 0]]); r.tilt = track(f, [[E.stepBack - 6, -5], [E.stepBack + 14, 0]]);}
      if (f >= E.stepBack && f < a1.endFrame + 24) r.brow = -.35;
      if (f >= mo.startFrame) {
        // sighs and slumps, a hand to her cheek
        const s3 = sigh(f, mo.startFrame + 18);
        r.gy = .6; r.brow = -.5; r.mouth = 'frown'; r.shoulder = 2 + s3.shoulder; r.breath = (r.breath ?? 0) + s3.breath; r.puff = puffOf(f, mo.startFrame + 22);
        r.tilt = track(f, [[mo.startFrame, 0], [mo.startFrame + 30, 5]]);
        r.limbL = handTo(f, mo.startFrame + 6, mo.startFrame + 24, E.pullEnd + 400, E.pullEnd + 420, LAP_L, AISHA_CHEEK);
      }
    } else {
      r.shoulder = -1;
      r.brow = cupLanded ? .3 : -.45;
      // half-following the supplier talk: glances between the tiles, down at her clipboard, unsure where to jump in; mouth stays closed
      if (f >= E.hesitate && f < E.catchupIn + 60) {
        r.shoulder = -2 - 2 * seg(f, E.hesitate, E.hesitate + 20);
        r.gx = track(f, [[E.hesitate, 0], [E.hesitate + 26, -.9], [E.hesitate + 52, .9], [E.hesitate + 78, -.6]]);
        r.gy = track(f, [[E.hesitate + 80, 0], [E.hesitate + 96, .9], [E.hesitate + 130, .9], [E.hesitate + 146, 0]]);
        r.brow = .3 * Math.sin((f - E.hesitate) / 30); r.mouth = 'flat';
      }
      if (f >= E.catchupIn + 20 && f < E.pointIn + 60) r.gx = track(f, [[E.catchupIn + 20, .4], [E.catchupIn + 60, .9]]);
      if (f >= a2.startFrame - 6 && f < a2.endFrame) r.gx = 0;
      if (f >= a2.endFrame && f < E.s8End) {r.mouth = 'smile'; r.brow = .3; r.shoulder = -3;}
    }
  }
  if (f >= E.nextBuzz) {r.brow = .3; r.shoulder = -3; r.gx = 0; r.gy = 0; r.tilt = 0; r.mouth = talkMouth(f, who, voice, 'smile');}
  return r;
};

/** Aisha half out of the tile while she takes a call off-screen, then back: the figure slides and leans (portrait units), the room behind her stays put. Eased both ways, no rebound. */
export const aishaShift = (f: number): {x: number; rot: number} => {
  const k = f < E.stepBack ? seg(f, E.stepOut, E.stepOut + 28) : 1 - seg(f, E.stepBack, E.stepBack + 28);
  return {x: 175 * k, rot: 4 * k};
};
/** Is the tile mic shown muted? Aisha mutes while she steps away, is live for her lines, quiet in between. */
export const isMuted = (who: number, f: number): boolean => {
  if (who !== 2) return false;
  if (f < E.stepBack - 4) return f >= E.stepOut;
  const a1 = line('aisha1');
  if (f < a1.endFrame + 20) return false;
  return f < E.unmute;
};
