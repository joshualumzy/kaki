// The physical world: the café counter, props and vignettes. Everything is vector, drawn here.
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {Hand, RigPortrait, Rig} from './rig';
import {EnvelopeBody} from './cards';
import {clamp01, mix, seg, easeIn, easeOut, easeCam} from './motion';

const SKIN_MEI = '#dfa78b';
const ramp01 = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

export const LAP = {x: 880, y: 540, w: 500, h: 300};
export const SCREEN = {x: LAP.x + 21.5, y: LAP.y + 21.5, w: 457, h: 257};
export const SCREEN_C: [number, number] = [SCREEN.x + SCREEN.w / 2, SCREEN.y + SCREEN.h / 2];
export const PUSH_SCALE = 1920 / SCREEN.w;
const MEI = {x: 330, y: 80, w: 510, h: 680};
/** Portrait (600x800) point to world point for the seated Mei. */
export const meiPt = (x: number, y: number): [number, number] => [MEI.x + x * MEI.w / 600, MEI.y + y * MEI.h / 800];

export const Camera: React.FC<{cx: number; cy: number; s: number; children: React.ReactNode; blur?: number}> = ({cx, cy, s, children, blur = 0}) =>
  <AbsoluteFill style={{transformOrigin: '0 0', transform: `translate(960px,540px) scale(${s}) translate(${-cx}px,${-cy}px)`, filter: blur ? `blur(${blur}px)` : undefined}}>{children}</AbsoluteFill>;

const Steam: React.FC<{f: number; x: number; y: number}> = ({f, x, y}) => <g>{[0, 1].map((i) => {
  const t = ((f + i * 30) % 60) / 60;
  return <path key={i} d={`M${x + i * 16 - 8} ${y} q-9 -14 0 -26 q9 -12 0 -26`} stroke="#fffaf0" strokeWidth="5" fill="none" strokeLinecap="round" opacity={Math.sin(Math.PI * t) * .55} transform={`translate(${Math.sin(t * 5 + i) * 4} ${-t * 20})`}/>;
})}</g>;

const hexMix = (a: string, b: string, t: number) => '#' + [1, 3, 5].map((i) => Math.round(mix(parseInt(a.slice(i, i + 2), 16), parseInt(b.slice(i, i + 2), 16), t)).toString(16).padStart(2, '0')).join('');
/** light 0 is the grey Monday morning; 1 is the sunny morning (bright warm sky, a real sun, green hills). */
const CafeBack: React.FC<{light: number}> = ({light}) => <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{position: 'absolute', inset: 0}}>
  <defs>
    <linearGradient id="v10-wall" x2="0" y2="1"><stop stopColor="#efe3cb"/><stop offset="1" stopColor="#e0cfae"/></linearGradient>
    <linearGradient id="v10-glass" x2="0" y2="1"><stop stopColor={hexMix('#bcd0dd', '#5fbcf5', light)}/><stop offset="1" stopColor={hexMix('#e7e4d8', '#ffeeb0', light)}/></linearGradient>
    <linearGradient id="v10-shaft" x1="0" x2="1"><stop stopColor="#fff2d0" stopOpacity=".55"/><stop offset="1" stopColor="#fff2d0" stopOpacity="0"/></linearGradient>
    <linearGradient id="v10-top" x2="0" y2="1"><stop stopColor="#d9ae74"/><stop offset="1" stopColor="#b98a55"/></linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#v10-wall)"/>
  <rect y="560" width="1920" height="180" fill="#b9cfc3"/><path d="M0 560h1920" stroke="#8fae9f" strokeWidth="8"/>
  <g><rect x="80" y="110" width="500" height="450" rx="10" fill="#7a5b3c"/><rect x="100" y="130" width="460" height="410" fill="url(#v10-glass)"/>
    <path d="M330 130v410M100 330h460" stroke="#7a5b3c" strokeWidth="12"/>
    <path d="M100 470q90-40 170-10t160-6 130 20v66H100z" fill={hexMix('#aab5ae', '#78bb62', light)} opacity={.7 + .3 * light}/>
    <circle cx="460" cy="230" r={96} fill="#ffe9a0" opacity={.34 * light}/>
    <circle cx="460" cy="230" r={60 + 12 * light} fill={hexMix('#fff6dd', '#ffd34a', light)} opacity={.55 + .45 * light}/></g>
  <path d="M100 540L700 800 H980L560 540z" fill="url(#v10-shaft)" opacity={.35 + .5 * light}/>
  <rect x="1100" y="110" width="600" height="210" rx="10" fill="#6a4a30"/><rect x="1116" y="126" width="568" height="178" fill="#2c3b38"/>
  <path d="M1150 180h200M1150 220h280M1150 260h160M1500 180h140M1500 220h120" stroke="#e8efe6" strokeWidth="7" strokeLinecap="round" opacity=".7"/>
  <rect x="1020" y="410" width="780" height="14" fill="#7a5b3c"/>
  {[1060, 1150, 1240, 1450, 1540, 1700].map((x, i) => <g key={x}><rect x={x} y={i % 2 ? 350 : 360} width={i % 2 ? 56 : 66} height={i % 2 ? 60 : 50} rx="8" fill={['#f4efe4', '#c9d9d0', '#e3b98a'][i % 3]} stroke="#b9ad98" strokeWidth="3"/></g>)}
  <path d="M1300 0v60M1420 0v90M1580 0v50" stroke="#5a4a3a" strokeWidth="4"/>{[[1300, 60], [1420, 90], [1580, 50]].map(([x, y]) => <path key={x} d={`M${x - 36} ${y + 40}q36 -52 72 0z`} fill="#c8a574"/>)}
  <path d="M0 735H1920V905H0z" fill="url(#v10-top)"/><path d="M0 735H1920" stroke="#e8c795" strokeWidth="6"/>
  <path d="M0 905H1920V1080H0z" fill="#7a5233"/>{Array.from({length: 17}, (_, i) => <path key={i} d={`M${i * 120} 905V1080`} stroke="#6a4529" strokeWidth="4"/>)}
  <path d="M0 905H1920" stroke="#5b3b22" strokeWidth="8"/>
</svg>;

const Phone: React.FC<{f: number; buzzAt?: number; lit: number}> = ({f, buzzAt, lit}) => {
  const age = buzzAt == null ? 99 : f - buzzAt;
  const jit = age >= 0 && age < 10 ? Math.sin(age * Math.PI) * 2 * (age % 2 ? 1 : -1) : 0;
  return <g transform={`translate(${420 + jit} 640) scale(.66)`}>
    <path d="M0 296h170l-14 18H14z" fill="#5a4a3a" opacity=".5"/>
    <rect width="170" height="300" rx="24" fill="#151c30" stroke="#2c3556" strokeWidth="4"/>
    <rect x="10" y="12" width="150" height="276" rx="16" fill={`rgb(${mix(13, 40, lit)},${mix(17, 60, lit)},${mix(30, 98, lit)})`}/>
    <g opacity={lit}>
      <text x="85" y="62" textAnchor="middle" fontSize="40" fontWeight="300" fill="#e8f0ff" fontFamily="sans-serif">9:00</text>
      <rect x="20" y="90" width="130" height="112" rx="14" fill="#f4f7ff"/>
      <path d="M38 124q0 -16 12 -16t12 16l4 9h-32zM46 138h8" fill="none" stroke="#c0661f" strokeWidth="3" strokeLinecap="round"/>
      <text fontSize="15" fontWeight="700" fill="#0d1117" fontFamily="sans-serif">{['Monday', 'team', 'meeting'].map((w, i) => <tspan key={w} x="70" y={114 + i * 17.25}>{w}</tspan>)}</text>
    </g>
  </g>;
};

const Mug: React.FC<{x: number; y: number}> = ({x, y}) => <g transform={`translate(${x} ${y})`}>
  <path d="M-34 -62h68v70q0 22-22 22h-24q-22 0-22-22z" fill="#f4efe4" stroke="#b9ad98" strokeWidth="4"/>
  <path d="M34 -48q28 2 26 22t-28 16" stroke="#b9ad98" strokeWidth="8" fill="none"/>
  <ellipse cx="0" cy="-60" rx="30" ry="7" fill="#6a4630"/>
</g>;

/**
 * The laptop. The lid is drawn in flat 2D (no perspective, no rotateX): a lid folded almost edge-on is a thin, foreshortened trapezoid
 * (wider at its top edge, which swings towards the viewer) and a 3D-transformed layer next to the flat base made Chrome composite the base
 * in and out from frame to frame (the flicker at the bottom of the laptop).
 */
const Laptop: React.FC<{open: number; on: number; glowOn?: number; children?: React.ReactNode}> = ({open, on, children}) => {
  const SC = SCREEN.w / 1920;
  const th = 88 * (1 - open) * Math.PI / 180, top = 1400 / (1400 - LAP.h * Math.sin(th)), ins = LAP.w * (1 - 1 / top) / 2;
  return <div style={{position: 'absolute', left: LAP.x - 40, top: LAP.y, width: LAP.w + 80, height: LAP.h + 40}}>
    <div style={{position: 'absolute', left: 40, top: 0, width: LAP.w, height: LAP.h, transformOrigin: '50% 100%', transform: `scale(${top}, ${Math.cos(th) * top})`, clipPath: `polygon(0 0, 100% 0, calc(100% - ${ins}px) 100%, ${ins}px 100%)`, background: 'linear-gradient(#aab3b8,#8b959b)', borderRadius: '16px 16px 4px 4px'}}>
      <div style={{position: 'absolute', left: 21.5, top: 21.5, width: SCREEN.w, height: SCREEN.h, background: `rgb(${mix(154, 11, ramp01(open, .2, .5))},${mix(163, 15, ramp01(open, .2, .5))},${mix(168, 20, ramp01(open, .2, .5))})`, overflow: 'hidden', borderRadius: 3}}>
        <div style={{width: 1920, height: 1080, transformOrigin: '0 0', transform: `scale(${SC})`, opacity: on}}>{children}</div>
        <div style={{position: 'absolute', inset: 0, background: 'linear-gradient(120deg,#ffffff18,transparent 40%)', opacity: on}}/>
      </div>
    </div>
    <div style={{position: 'absolute', left: 0, top: LAP.h - 4, width: LAP.w + 80, height: 44, background: 'linear-gradient(#cfd5d8,#9aa3a8)', clipPath: 'polygon(7% 0,93% 0,100% 100%,0 100%)', borderRadius: '0 0 12px 12px'}}/>
  </div>;
};

const DATES = ['14', '21', '28', '4', '11']; // cold open and the Kaki meeting are Mon 14 Dec; the montage turns 21, 28, 4, 11; next Monday reads 21
const CAL = {x: 1560, y: 560, w: 270, h: 270};
/** Desk calendar. tear[i] 0..1 tears page i: corner curls, then the page drops down and away to the right, never across the laptop. Run backwards to rewind. */
const DeskCalendar: React.FC<{tear: number[]; rewind?: boolean}> = ({tear, rewind = false}) => {
  const page = (i: number): React.ReactNode => {
    const p = tear[i] ?? 0;
    const curl = easeCam(clamp01(p / .4)), fall = easeIn(clamp01((p - .4) / .6));
    const c = 64 * curl, w = CAL.w, h = CAL.h;
    const clip = `polygon(0 0,${w}px 0,${w}px ${h - c}px,${w - c}px ${h}px,0 ${h}px)`;
    return <div key={i} style={{position: 'absolute', left: 0, top: 0, width: w, height: h, opacity: rewind ? clamp01((1 - fall) / .3) : 1 - clamp01((fall - .55) / .45), transformOrigin: '50% 0', transform: `translate(${90 * fall}px,${300 * fall}px) rotate(${12 * fall}deg)`}}>
      <div style={{position: 'absolute', inset: 0, clipPath: clip, background: '#fff6e2', borderRadius: 8, textAlign: 'center', color: '#2a2018', overflow: 'hidden'}}>
        <div style={{height: 54, background: '#b94a33'}}/>
        <div style={{position: 'absolute', top: 0, left: 0, right: 0, height: 10, background: 'repeating-linear-gradient(90deg,#00000030 0 4px,transparent 4px 12px)'}}/>
        <div style={{marginTop: 20, fontSize: 36, letterSpacing: 6, fontWeight: 700, color: '#8a6f4a'}}>MON</div>
        <div style={{fontSize: 118, lineHeight: 1, fontWeight: 800}}>{DATES[i]}</div>
      </div>
      {curl > 0 && <div style={{position: 'absolute', left: w - c, top: h - c, width: c, height: c, background: 'linear-gradient(135deg,#efe4cc,#d9c9a6)', clipPath: 'polygon(0 100%,100% 0,0 0)', boxShadow: '-4px -4px 10px #0004'}}/>}
    </div>;
  };
  return <div style={{position: 'absolute', left: CAL.x, top: CAL.y, width: CAL.w, height: CAL.h + 30, filter: 'drop-shadow(0 12px 14px #0005)'}}>
    <div style={{position: 'absolute', left: 28, top: CAL.h - 10, width: CAL.w - 56, height: 38, background: '#6b4a2e', borderRadius: '4px 4px 10px 10px'}}/>
    <div style={{position: 'absolute', left: 0, top: 0, width: CAL.w, height: CAL.h, background: '#e8dcc0', borderRadius: 8, transform: 'translate(5px,5px)'}}/>
    {[4, 3, 2, 1, 0].map((i) => page(i))}
    {[60, 195].map((x) => <div key={x} style={{position: 'absolute', left: x, top: -14, width: 16, height: 44, background: '#b3b8b1', borderRadius: 8}}/>)}
  </div>;
};

const NOTE_TEXT = ['contract?', 'email Jade?', 'ask Raj', 'Jade??'];
// a cascade in the clear strip between the laptop (ends 1380) and the calendar (starts 1560): nothing touches either
const NOTE_POS = [{x: 1416, y: 566, r: 5, c: '#ffe27a'}, {x: 1430, y: 646, r: -4, c: '#ffd2a0'}, {x: 1414, y: 726, r: 4, c: '#ffb3c1'}, {x: 1428, y: 806, r: -5, c: '#fff1a8'}];
const StickyNote: React.FC<{i: number; p: number}> = ({i, p}) => {
  const n = NOTE_POS[i];
  if (p <= 0) return null;
  return <div style={{position: 'absolute', left: n.x, top: n.y, width: 118, height: 108, boxSizing: 'border-box', padding: '16px 12px', background: n.c, color: '#4a3d1a', fontSize: 26, lineHeight: 1.05, fontFamily: '"Marker Felt","Bradley Hand",cursive', fontWeight: 700, transform: `rotate(${n.r}deg) scale(${.9 + .1 * easeOut(clamp01(p))})`, opacity: clamp01(p * 2.5), boxShadow: '0 5px 8px #0005', borderRadius: 3}}>{NOTE_TEXT[i]}</div>;
};

export type WorldState = {
  f: number; light?: number; lid: number; screen?: React.ReactNode; screenOn?: number;
  mei: Rig; meiBlur?: number; phoneBuzz?: number; phoneLit?: number;
  /** Mei's right hand: mugHand 0 holds the mug up .. 1 mug set down; release 0 hand on the mug .. 1 resting beside it; reach 0 at rest .. 1 on the lid's top edge. */
  mugHand?: number; release?: number; reach?: number;
  phoneShow?: boolean; rewind?: boolean; tear?: number[]; notes?: number[]; env?: {x: number; flapDeg: number; letter: number; show: boolean};
};
const MUG_HOLD: [number, number] = [748, 584], MUG_DOWN: [number, number] = [772, 802];
const HAND_REST: [number, number] = [704, 806];
const ARM = {l1: 165, l2: 185};
/** Two-bone arm from the shoulder to the hand; the elbow bends down and out. */
const elbowFor = (S: [number, number], H: [number, number]): [number, number] => {
  const dx = H[0] - S[0], dy = H[1] - S[1], d = Math.min(Math.hypot(dx, dy), ARM.l1 + ARM.l2 - 1);
  const a = (ARM.l1 ** 2 - ARM.l2 ** 2 + d ** 2) / (2 * d), h = Math.sqrt(Math.max(0, ARM.l1 ** 2 - a * a));
  const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
  let px = -uy, py = ux;
  if (px * .5 + py < 0) {px = -px; py = -py;}
  return [S[0] + ux * a + px * h, S[1] + uy * a + py * h];
};
/** Top edge of the laptop lid as it opens (the lid hinges at the front, so the edge rises from the base to the top). */
const lidEdge = (open: number): [number, number] => [LAP.x + 20, LAP.y + LAP.h - LAP.h * Math.cos((88 * (1 - open) * Math.PI) / 180) + 16];
export const World: React.FC<WorldState> = ({f, light = 0, lid, screen, screenOn = 0, mei, meiBlur = 0, phoneShow = true, phoneBuzz, phoneLit = 0, mugHand = 1, release = 1, reach = 0, rewind = false, tear = [0, 0, 0, 0], notes = [0, 0, 0, 0], env}) => {
  const mug: [number, number] = [mix(MUG_HOLD[0], MUG_DOWN[0], mugHand), mix(MUG_HOLD[1], MUG_DOWN[1], mugHand)];
  const grip: [number, number] = [mug[0] + 46, mug[1] - 26]; // the fist closes round the handle
  const rest: [number, number] = [mix(grip[0], HAND_REST[0], release), mix(grip[1], HAND_REST[1], release)];
  const edge = lidEdge(lid);
  const hand: [number, number] = [mix(rest[0], edge[0], reach), mix(rest[1], edge[1], reach)];
  const S = meiPt(395, 565), elbow = elbowFor(S, hand);
  // world point -> the torso's own coordinates (undo the portrait's sway, breath, shoulder drop and torso squeeze)
  const sway = Math.sin(f / 18) * 2.5, drop = Math.max(0, mei.shoulder ?? 0), squeeze = 1 - drop * .004;
  const local = (w: [number, number]): [number, number] => [300 + ((w[0] - MEI.x) / .85 - 300) / squeeze, (w[1] - MEI.y) / .85 - sway - ((mei.shoulder ?? 0) + (mei.breath ?? 0))];
  const rig: Rig = {...mei, limbR: {pts: [local(S), local(elbow), local(hand)], a: 1, noHand: true}};
  const handAngle = Math.atan2(hand[1] - elbow[1], hand[0] - elbow[0]) * 180 / Math.PI;
  return <AbsoluteFill>
    <CafeBack light={light}/>
    <div style={{position: 'absolute', left: MEI.x, top: MEI.y, width: MEI.w, height: MEI.h, filter: meiBlur ? `blur(${meiBlur}px)` : undefined}}><RigPortrait who={0} f={f} rig={rig} bg={false} slice={false}/></div>
    <svg width="1920" height="1080" style={{position: 'absolute', inset: 0, filter: meiBlur ? `blur(${meiBlur}px)` : undefined}}>
      {phoneShow && <Phone f={f} buzzAt={phoneBuzz} lit={phoneLit}/>}
      <g><Mug x={mug[0]} y={mug[1]}/><Steam f={f} x={mug[0]} y={mug[1] - 66}/></g>
      <Hand x={hand[0]} y={hand[1]} angle={handAngle} skin={SKIN_MEI} fist={release < .3 && reach < .05}/>
    </svg>
    <Laptop open={lid} on={screenOn}>{screen}</Laptop>
    <DeskCalendar tear={tear} rewind={rewind}/>
    {NOTE_TEXT.map((_, i) => <StickyNote key={i} i={i} p={notes[i] ?? 0}/>)}
    {env && env.show && <Letter env={env}/>}
  </AbsoluteFill>;
};

/** The envelope on the counter: it is set down from the bottom of the frame, the flap opens, the letter rises out of the pocket. */
const Letter: React.FC<{env: {x: number; flapDeg: number; letter: number}}> = ({env}) => {
  const W = 330, H = 214;
  const cy = mix(1260, 800, env.x), rot = (1 - env.x) * -6;
  return <div style={{position: 'absolute', left: 700 - W / 2, top: cy - H / 2, width: W, height: H, transform: `rotate(${rot}deg)`}}>
    <EnvelopeBody w={W} h={H} flapDeg={env.flapDeg} sides={1} paper={1}>
    {/* the letter lives inside the envelope: it can rise out of the top, never poke out of the bottom */}
    <div style={{position: 'absolute', inset: 0, zIndex: 1, clipPath: 'inset(-400px -20px 0 -20px)', pointerEvents: 'none'}}>
      <div style={{position: 'absolute', left: 25, top: 26 - 152 * env.letter, width: 280, height: 190, background: '#fffdf6', border: '2px solid #d9d2bd', borderRadius: 4, padding: '16px 20px', boxSizing: 'border-box', color: '#1c2a2a', fontFamily: 'sans-serif', opacity: env.letter > 0 ? 1 : 0, boxShadow: '0 3px 8px #0003'}}>
        <div style={{fontSize: 21, fontWeight: 800, letterSpacing: '.02em', color: '#8a3b22'}}>Jade Packaging</div>
        <div style={{fontSize: 22, fontWeight: 600, lineHeight: 1.22, marginTop: 8}}>Your contract has renewed.</div>
        <div style={{fontSize: 22, fontWeight: 600, lineHeight: 1.22, marginTop: 6}}>New prices from 1 April.</div>
      </div>
    </div>
    </EnvelopeBody>
  </div>;
};

// ---- vignettes -------------------------------------------------------------------------------------------------
export const KitchenShot: React.FC<{f: number; rig: Rig; clockLook?: number}> = ({f, rig}) => <AbsoluteFill style={{background: '#dfe8e4'}}>
  <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{position: 'absolute', inset: 0}}>
    <rect width="1920" height="1080" fill="#dce7e2"/>
    {Array.from({length: 11}, (_, r) => Array.from({length: 22}, (_, c) => <rect key={`${r}-${c}`} x={c * 90 + (r % 2) * 45 - 45} y={r * 62} width="86" height="58" rx="3" fill="#eaf1ee" stroke="#c4d3cc" strokeWidth="2"/>))}
    <rect x="80" y="170" width="460" height="14" fill="#8e9a9a"/>{[110, 220, 330, 430].map((x, i) => <rect key={x} x={x} y={110 + (i % 2) * 14} width="70" height={60 - (i % 2) * 14} rx="6" fill={['#b4bcbc', '#d99a3e', '#9fb5aa', '#c8a574'][i]}/>)}
    <g transform="translate(1500 210)"><circle r="92" fill="#f8f5ec" stroke="#5a4a3a" strokeWidth="10"/>{Array.from({length: 12}, (_, i) => <path key={i} d={`M0 -76v${i % 3 ? 8 : 16}`} stroke="#3a3a3a" strokeWidth="4" transform={`rotate(${i * 30})`}/>)}
      <path d="M0 0L-24 -44" stroke="#222" strokeWidth="8" strokeLinecap="round" transform="rotate(-8)"/><path d="M0 0L5 -62" stroke="#222" strokeWidth="5" strokeLinecap="round" transform="rotate(312)"/><circle r="7" fill="#222"/></g>
    <rect y="900" width="1920" height="180" fill="#9aa5a8"/><path d="M0 900H1920" stroke="#c5ced0" strokeWidth="10"/>
  </svg>
  <div style={{position: 'absolute', left: 660, top: 150, width: 600, height: 800}}><RigPortrait who={1} f={f} rig={rig} bg={false} slice={false}/></div>
  <svg width="1920" height="1080" style={{position: 'absolute', inset: 0}}><g><ellipse cx="960" cy="905" rx="360" ry="46" fill="#b5b9bd" stroke="#8a8f94" strokeWidth="5"/><rect x="760" y="850" width="130" height="50" rx="22" fill="#e0b46a"/><rect x="920" y="858" width="110" height="46" rx="22" fill="#d79a4f"/><rect x="1060" y="850" width="130" height="52" rx="24" fill="#e3bd78"/></g></svg>
</AbsoluteFill>;

export const StreetShot: React.FC<{f: number; rig: Rig}> = ({f, rig}) => <AbsoluteFill style={{background: '#cfe0ea'}}>
  <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{position: 'absolute', inset: 0}}>
    <defs><linearGradient id="v10-sky" x2="0" y2="1"><stop stopColor="#c8dbe8"/><stop offset="1" stopColor="#efe6d3"/></linearGradient><pattern id="v10-aw" width="80" height="120" patternUnits="userSpaceOnUse"><rect width="40" height="120" fill="#b8502c"/><rect x="40" width="40" height="120" fill="#fff0c8"/></pattern></defs>
    <rect width="1920" height="1080" fill="url(#v10-sky)"/>
    <rect x="1120" y="110" width="760" height="800" fill="#c9b38e"/><rect x="1160" y="360" width="680" height="540" fill="#3f6b60"/><rect x="1190" y="390" width="270" height="400" fill="#9fc2b2"/><rect x="1500" y="390" width="310" height="400" fill="#9fc2b2"/>
    <path d="M1160 240h680l50 130H1110z" fill="url(#v10-aw)"/>
    <rect x="40" y="200" width="420" height="700" fill="#d8c4a0"/><rect x="90" y="260" width="140" height="200" fill="#a9bfc9"/><rect x="270" y="260" width="140" height="200" fill="#a9bfc9"/><rect x="90" y="520" width="140" height="200" fill="#a9bfc9"/>
    <rect y="900" width="1920" height="180" fill="#b8b4aa"/><path d="M0 900H1920" stroke="#8f8c84" strokeWidth="8"/>{Array.from({length: 12}, (_, i) => <path key={i} d={`M${i * 170} 900l-40 180`} stroke="#a09d94" strokeWidth="4"/>)}
    <rect x="1010" y="640" width="58" height="260" rx="8" fill="#5e6e6a"/>
  </svg>
  <div style={{position: 'absolute', left: 660, top: 150, width: 600, height: 800}}><RigPortrait who={2} f={f} rig={rig} bg={false} slice={false}/></div>
</AbsoluteFill>;
// keep helpers referenced by the film file
export {seg};
