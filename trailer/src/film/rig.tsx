// Rigged portraits. Paths are the approved Style B drawings split into body / head / eyes / brows / mouth / arms
// groups with transform origins at the neck, shoulders and elbows. Only mouths, brows and temple/phone arms are new.
import React from 'react';
import {ampAt} from './timeline';
import {clamp01} from './motion';

export type Mouth = 'rest' | 'smile' | 'open' | 'o' | 'flat' | 'frown';
export type Limb = {pts: [number, number][]; a: number; noHand?: boolean};
export type Rig = {
  tilt?: number; browIn?: number; gx?: number; gy?: number; blink?: number; brow?: number; shoulder?: number; breath?: number; mouth?: Mouth;
  armL?: number; armR?: number; limbL?: Limb; limbR?: Limb; phoneUp?: number; phoneScroll?: number; wide?: number; puff?: number; puffAt?: [number, number]; pose?: 'phone' | 'clip' | 'ear'; mugUp?: number;
  /** The figure slides sideways (portrait units) and leans while the room behind stays put. */
  shiftX?: number; shiftRot?: number;
};
const ORANGE = '#ff5a1f', TEAL = '#0b6b5c';
const SLEEVE = ['#a5abe6', '#073e3e', '#292b58'];
const SKIN = ['#dfa78b', '#c98959', '#aa6850'];

// Blink schedules: each character blinks on its own cadence (97 / 131 / 113 f with seeded offsets); no two blinks overlap.
const schedule = (() => {
  const periods = [97, 131, 113], seeds = [[3, -8, 6, -2, 9, -5, 1, 7], [-6, 4, 10, -9, 2, 8, -3, 5], [8, -4, -9, 5, 0, -7, 9, -1]];
  const starts: number[][] = [[], [], []];
  const taken: number[] = [];
  for (let k = 1; k < 80; k++) for (let who = 0; who < 3; who++) {
    let s = k * periods[who] + seeds[who][k % 8] + who * 17;
    while (taken.some((t) => Math.abs(t - s) < 9)) s += 9;
    taken.push(s); starts[who].push(s);
  }
  return starts;
})();
/** 0 open .. 1 closed, a 5 f blink. */
export const blinkAmt = (who: number, f: number): number => {
  for (const s of schedule[who]) {
    const d = f - s;
    if (d >= 0 && d < 5) return d === 2 ? 1 : d === 1 || d === 3 ? .7 : .3;
    if (d >= 5) continue;
    if (d < 0) break;
  }
  return 0;
};

const TALK = ['open', 'o', 'open', 'rest', 'o', 'open', 'o', 'rest'] as const;
/** Mouth shape while a recorded line plays: flaps follow the voice amplitude, rest in silence. */
export const talkMouth = (f: number, who: number, voice: 'mei' | 'raj' | 'aisha', fallback: Mouth = 'rest'): Mouth => {
  const a = ampAt(f, voice);
  if (a < .1) return fallback;
  const pick = TALK[(Math.floor(f / 4) * 3 + who * 2) % 8];
  return a > .55 ? (pick === 'rest' ? 'o' : pick) : (pick === 'open' ? 'o' : pick === 'rest' ? 'rest' : 'o');
};
type MouthSpec = {cx: number; cy: number; hw: number; color: string; stroke?: number};
const MouthShape: React.FC<{m: Mouth; s: MouthSpec}> = ({m, s}) => {
  const {cx, cy, hw, color} = s, sw = s.stroke ?? 4;
  if (m === 'open') return <g><ellipse cx={cx} cy={cy + 6} rx={15} ry={11} fill="#3a1c1c" stroke={color} strokeWidth={sw}/></g>;
  if (m === 'o') return <ellipse cx={cx} cy={cy + 5} rx={8} ry={9} fill="#3a1c1c" stroke={color} strokeWidth={sw}/>;
  if (m === 'smile') return <path d={`M${cx - hw - 4} ${cy - 3} Q${cx} ${cy + 26} ${cx + hw + 4} ${cy - 3}`} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round"/>;
  if (m === 'frown') return <path d={`M${cx - hw - 2} ${cy + 10} Q${cx} ${cy - 14} ${cx + hw + 2} ${cy + 10}`} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round"/>;
  if (m === 'flat') return <path d={`M${cx - hw + 3} ${cy + 3} L${cx + hw - 3} ${cy + 1}`} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round"/>;
  return <path d={`M${cx - hw} ${cy} q${hw} 16 ${2 * hw} -2`} stroke={color} strokeWidth={sw} fill="none" strokeLinecap="round"/>;
};
const Brows: React.FC<{l: [number, number]; r: [number, number]; half: number; color: string; brow: number; browIn?: number; w?: number}> = ({l, r, half, color, brow, browIn = 0, w = 6}) => {
  const worry = Math.max(0, -brow) * 12 + browIn * 16, lift = brow * -10;
  const one = (c: [number, number], sign: number) => <g transform={`translate(0 ${lift + Math.max(0, -brow) * 3}) rotate(${-sign * worry} ${c[0]} ${c[1]})`}>
    <path d={`M${c[0] - half} ${c[1] + 2 * sign * -1} L${c[0] + half} ${c[1] + 2 * sign}`} stroke={color} strokeWidth={w} strokeLinecap="round"/></g>;
  return <g>{one(l, 1)}{one(r, -1)}</g>;
};
const Eyes: React.FC<{l: [number, number]; r: [number, number]; rx: number; ry: number; gx: number; gy: number; blink: number; fill: string; wide?: number}> = ({l, r, rx, ry, gx, gy, blink, fill, wide = 0}) => {
  // wide eyes show round whites around a smaller pupil; the pupil keeps tracking the gaze
  const wr = rx * 2.6 * wide * (1 - blink);
  return <g fill={fill}>{[l, r].map((c, i) => <g key={i}>
    {wide > .05 && <ellipse cx={c[0]} cy={c[1]} rx={rx + wr} ry={ry + wr * .95} fill="#fffdf6" stroke={fill} strokeWidth={2} opacity={Math.min(1, wide * 2)}/>}
    <ellipse cx={c[0] + gx * 7 * (1 + wide)} cy={c[1] + gy * 5} rx={rx * (1 + wide * .15)} ry={Math.max(1, (ry * (1 + wide * .15)) - (ry - 1) * blink)}/>
  </g>)}</g>;
};
const shade = (hex: string, k: number) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('');
/** A hand pointing along `angle` (degrees): palm, four fingers and a thumb, outlined so it reads against the sleeve and the face. */
export const Hand: React.FC<{x: number; y: number; angle: number; skin: string; scale?: number; fist?: boolean}> = ({x, y, angle, skin, scale = 1, fist = false}) => {
  const edge = shade(skin, .72);
  if (fist) return <g transform={`translate(${x} ${y}) scale(${scale})`} stroke={edge} strokeWidth={2.5} fill={skin} strokeLinejoin="round" strokeLinecap="round">
    <circle r={22}/>
    <path d="M-12 -9q14 6 26 -1M-13 2q15 7 28 0M-11 13q14 6 24 0" fill="none"/>
    <ellipse cx={-3} cy={-21} rx={11} ry={7} transform="rotate(-20 -3 -21)"/>
  </g>;
  return <g transform={`translate(${x} ${y}) rotate(${angle}) scale(${scale})`} stroke={edge} strokeWidth={2.5} fill={skin} strokeLinejoin="round">
    {[-13, -4.5, 4.5, 13].map((fy, i) => <rect key={i} x={10} y={fy - 4.5} width={20 - Math.abs(i - 1.5) * 2} height={9} rx={4.5}/>)}
    <ellipse cx={4} cy={0} rx={21} ry={19}/>
    <ellipse cx={-2} cy={-19} rx={12} ry={7} transform="rotate(-25 -2 -19)"/>
  </g>;
};
const LimbArm: React.FC<{limb?: Limb; color: string; skin: string}> = ({limb, color, skin}) => {
  if (!limb || limb.a <= 0) return null;
  const [s, e, h] = limb.pts, edge = shade(color, .78);
  const up = `M${s[0]} ${s[1]} L${e[0]} ${e[1]}`, fore = `M${e[0]} ${e[1]} L${h[0]} ${h[1]}`;
  const ang = Math.atan2(h[1] - e[1], h[0] - e[0]) * 180 / Math.PI;
  return <g opacity={limb.a} strokeLinecap="round" strokeLinejoin="round" fill="none">
    <path d={up} stroke={edge} strokeWidth={54}/><path d={fore} stroke={edge} strokeWidth={46}/>
    <path d={up} stroke={color} strokeWidth={48}/><path d={fore} stroke={color} strokeWidth={40}/>
    <circle cx={e[0]} cy={e[1]} r={20} fill={color} stroke="none"/>
    {!limb.noHand && <Hand x={h[0]} y={h[1]} angle={ang} skin={skin}/>}
  </g>;
};
const Mug: React.FC<{x: number; y: number}> = ({x, y}) => <g transform={`translate(${x} ${y})`}><rect x={-26} y={-40} width={52} height={56} rx={8} fill="#f4efe4" stroke="#b9ad98" strokeWidth={3}/><path d="M26 -28q22 2 20 18t-22 14" stroke="#b9ad98" strokeWidth={6} fill="none"/><ellipse cx={0} cy={-38} rx={22} ry={5} fill="#6a4630"/></g>;

export const RigPortrait: React.FC<{who: number; f: number; rig?: Rig; bg?: boolean; slice?: boolean; style?: React.CSSProperties}> = ({who, f, rig = {}, bg = true, slice = true, style}) => {
  const {wide = 0, puff = 0, tilt = 0, browIn = 0, gx = 0, gy = 0, brow = 0, shoulder = 0, breath = 0, mouth = 'rest', armL = 0, armR = 0, limbL, limbR, phoneUp = 0, phoneScroll = 0, pose = 'clip', mugUp = 0} = rig;
  const blink = rig.blink ?? blinkAmt(who, f);
  const id = `rig-${who}`;
  const sway = Math.sin(f / 18 + who) * 2.5;
  const drop = Math.max(0, shoulder);
  const shift = `translate(0 ${shoulder + breath})`;
  const torso = `translate(300 520) scale(${1 - drop * .004} 1) translate(-300 -520)`;
  const head = `translate(${gx * 6} ${gy * 4}) rotate(${tilt} 300 440)`;
  const figure = `translate(${rig.shiftX ?? 0} 0) rotate(${rig.shiftRot ?? 0} 300 800)`;
  return <svg width="100%" height="100%" viewBox="0 0 600 800" preserveAspectRatio={slice ? 'xMidYMid slice' : 'xMidYMid meet'} style={{overflow: 'visible', ...style}}>
    <defs>
      <linearGradient id={`${id}-bg`} x2="1" y2="1"><stop stopColor={['#666cef', '#118d7b', '#fa8244'][who]}/><stop offset="1" stopColor={['#232e81', '#064b47', '#a73a32'][who]}/></linearGradient>
      <linearGradient id={`${id}-cloth`} x2=".9" y2="1"><stop stopColor={['#d4d4ff', '#fff0cd', '#ffb470'][who]}/><stop offset="1" stopColor={['#8f96dc', '#d2b993', '#e06538'][who]}/></linearGradient>
      <pattern id={`${id}-grain`} width="9" height="9" patternUnits="userSpaceOnUse"><circle cx="2" cy="3" r=".7" fill="white" opacity=".15"/><circle cx="7" cy="8" r=".6" fill="#0d1117" opacity=".12"/></pattern>
    </defs>
    {bg && <>
      <path fill={`url(#${id}-bg)`} d="M0 0h600v800H0z"/>
      {who === 1 ? <g opacity=".35"><path d="M35 186h530M35 338h530" stroke="#7bdebf" strokeWidth="10"/><path d="M73 184V95h52v89m42 0v-64h64v64m138 150v-91h80v91m20-149V77h43v108" fill="#aed3b4"/><path d="M0 640h600v160H0z" fill="#043c36"/></g>
        : who === 0 ? <><path d="M387 0v800M399 0v800" stroke="#c4c8ff" strokeWidth="4" opacity=".3"/><path d="M27 800V560q82-125 57-278 125 70 66 263 66-110 127-110-5 121-89 160v205" fill="#162b59" opacity=".5"/></>
        : <><path d="M78 800V229a221 221 0 0 1 442 0v571" fill="#ffb266" opacity=".28"/><path d="M100 800V246a198 198 0 0 1 396 0" stroke="#ffd29b" strokeWidth="5" fill="none" opacity=".22"/></>}
    </>}
    <g transform={`translate(0 ${sway})`}><g transform={figure}><g transform={shift}>
      {who === 0 && <MeiRig {...{f, head, torso, brow, browIn, blink, gx, gy, mouth, armL, armR, limbL, limbR, id, wide}}/>}
      {who === 1 && <RajRig {...{f, head, torso, brow, browIn, blink, gx, gy, mouth, armL, armR, limbL, limbR, id, phoneUp, phoneScroll, mugUp, wide}}/>}
      {who === 2 && <AishaRig {...{f, head, torso, brow, browIn, blink, gx, gy, mouth, armL, armR, limbL, limbR, id, pose, tilt, wide}}/>}
    {puff > 0 && <Puff p={puff} who={who}/>}
    </g></g></g>
    {bg && <path fill={`url(#${id}-grain)`} d="M0 0h600v800H0z"/>}
  </svg>;
};

/** A soft breath puff that leaves from beside the face and drifts away from it: it never sits on the face. */
const PUFF_FROM: [number, number][] = [[442, 398], [442, 376], [452, 412]];
const Puff: React.FC<{p: number; who: number}> = ({p, who}) => {
  const at = PUFF_FROM[who], id = `puff-${who}`;
  return <g opacity={Math.sin(Math.PI * Math.min(1, p)) * .8}>
    <defs><radialGradient id={id}><stop offset="0" stopColor="#ffffff" stopOpacity=".85"/><stop offset="1" stopColor="#ffffff" stopOpacity="0"/></radialGradient></defs>
    {[0, 1, 2].map((i) => <circle key={i} cx={at[0] + p * (34 + i * 22) + i * 6} cy={at[1] - p * (10 + i * 9) - i * 3} r={10 + i * 6 + p * 12} fill={`url(#${id})`}/>)}
  </g>;
};

type Part = {wide: number; f: number; head: string; torso: string; brow: number; browIn: number; blink: number; gx: number; gy: number; mouth: Mouth; armL: number; armR: number; limbL?: Limb; limbR?: Limb; id: string};

const MeiRig: React.FC<Part> = ({wide, head, torso, brow, browIn, blink, gx, gy, mouth, armL, armR, limbL, limbR, id}) => <>
  <g transform={head}><path d="M149 418V211q-8-128 133-131 133-8 148 136v233l-74 24-174-12z" fill="#171e35"/></g>
  <g id="shoulders" transform={torso}>
    <path d="M62 800V613q0-122 164-147h132q167 32 178 147v187" fill={`url(#${id}-cloth)`}/>
    <path d="M253 392h91v111l-46 49-45-49" fill="#c98d75"/>
    <path d="m251 494 47 58 47-58 57 306H192z" fill="#fff3da"/>
    <g id="armL" transform={`rotate(${armL} 223 476)`} opacity={limbL && limbL.a > .5 ? 0 : 1}><path d="m223 476-54 86 52 38-31 39 67 161" fill="none" stroke="#7e83c5" strokeWidth="5"/></g>
    <g id="armR" transform={`rotate(${armR} 339 476)`} opacity={limbR && limbR.a > .5 ? 0 : 1}><path d="m339 476 48 86-49 38 29 39-62 161" fill="none" stroke="#7e83c5" strokeWidth="5"/></g>
    <path d="m167 569 12-12 12 12-12 12z" fill={ORANGE}/><path d="M426 655h58m-55 12h52" stroke="#6e78b8" strokeWidth="4"/>
  </g>
  <g id="head" transform={head}>
    <path d="M203 231q14-98 98-100 92 0 94 100v91q-2 110-96 119-92-9-96-119" fill="#dfa78b"/>
    <path d="M178 248q118 0 151-127l69 119 13-66-75-72-112 33z" fill="#171e35"/>
    <g fill="none" stroke="#252a48" strokeWidth="5"><rect x="216" y="272" width="68" height="43" rx="17"/><rect x="315" y="272" width="68" height="43" rx="17"/><path d="M284 287h31"/></g>
    <g id="brows"><Brows l={[250, 255]} r={[349, 255]} half={22} color="#171e35" brow={brow} browIn={browIn} w={5}/></g>
    <g id="eyes"><Eyes l={[253, 291]} r={[344, 291]} rx={4} ry={5} gx={gx} gy={gy} blink={blink} wide={wide} fill="#29283d"/></g>
    <path d="m294 307-5 29h13" stroke="#a25e53" strokeWidth="4" fill="none" strokeLinecap="round"/>
    <g id="mouth"><MouthShape m={mouth} s={{cx: 298, cy: 368, hw: 26.5, color: '#a25e53'}}/></g>
    <circle cx="202" cy="340" r="10" fill="none" stroke="#ffc075" strokeWidth="5"/><circle cx="397" cy="340" r="10" fill="none" stroke="#ffc075" strokeWidth="5"/>
  </g>
  <g transform={torso}><LimbArm limb={limbL} color={SLEEVE[0]} skin={SKIN[0]}/><LimbArm limb={limbR} color={SLEEVE[0]} skin={SKIN[0]}/></g>
</>;

const RajRig: React.FC<Part & {phoneUp: number; phoneScroll: number; mugUp: number}> = ({wide, head, torso, brow, browIn, blink, gx, gy, mouth, armL, armR, limbL, limbR, id, phoneUp, phoneScroll, mugUp}) => {
  const crossed = 1 - Math.max(limbL?.a ?? 0, limbR?.a ?? 0);
  return <>
  <g id="shoulders" transform={torso}>
    <path d="M38 800V613q7-145 193-160h130q194 30 202 160v187" fill="#073e3e"/>
    <path d="M246 371h111v118q-55 45-111 0" fill="#a96643"/>
    {/* the hanging sleeve of an arm that is raised is not drawn, and a raised arm uncrosses both forearms: never more than two arms */}
    <path d="m224 467-26 166" stroke={ORANGE} strokeWidth="22" opacity={1 - (limbL?.a ?? 0)}/><path d="m382 467 26 166" stroke={ORANGE} strokeWidth="22" opacity={1 - (limbR?.a ?? 0)}/>
    <path d="M203 552h198l43 248H160z" fill={`url(#${id}-cloth)`}/>
    <path d="M240 656h128v100q-63 22-128 0z" fill="#c2a984" stroke="#b49b79" strokeWidth="3"/>
    <path d="M252 671h104" stroke="#ffedc7" strokeWidth="4"/><path d="m357 697 11-59m-2 50 19-44" stroke={TEAL} strokeWidth="7"/>
    <g id="armL" transform={`rotate(${armL} 130 700)`} opacity={crossed}><path d="M93 690q27-43 78-18l104 69-25 45-111-48" fill="#c98959"/></g>
    <g id="armR" transform={`rotate(${armR} 470 700)`} opacity={crossed}><path d="M506 690q-27-43-78-18l-92 69 25 45 99-48" fill="#c98959"/></g>
    <path d="m416 705 28 95h51l-24-107" fill="#f1dfba"/><path d="m448 721 19 79m-7-82 19 82" stroke={ORANGE} strokeWidth="4"/>
    {phoneUp > 0 && <g transform={`translate(0 ${140 * (1 - phoneUp)})`}><g transform="rotate(-9 350 760)"><rect x="306" y="665" width="88" height="170" rx="16" fill="#151c30" stroke="#ffc98d" strokeWidth="5"/><rect x="316" y="682" width="68" height="124" rx="6" fill="#4d5a9c"/><clipPath id={`${id}-pclip`}><rect x="316" y="682" width="68" height="124"/></clipPath><g clipPath={`url(#${id}-pclip)`}>{[0, 1, 2, 3, 4, 5, 6].map((k) => <rect key={k} x="326" y={682 + ((k * 22 + phoneScroll) % 154) - 12} width={k % 2 ? 36 : 48} height="8" rx="3" fill="#9fb0ff"/>)}</g><ellipse cx="297" cy="780" rx="17" ry="30" fill="#c98959"/><ellipse cx="403" cy="780" rx="17" ry="30" fill="#c98959"/></g></g>}
    {mugUp > 0 && <g transform={`translate(0 ${60 * (1 - mugUp)})`}><Mug x={360} y={700}/><ellipse cx="318" cy="722" rx="20" ry="24" fill="#c98959"/></g>}
  </g>
  <g id="head" transform={head}>
    <path d="M214 222q0-109 91-109 102 0 102 109v102q-4 110-103 119-89-14-90-119" fill="#c98959"/>
    <ellipse cx="210" cy="292" rx="16" ry="29" fill="#c98959"/><ellipse cx="407" cy="292" rx="16" ry="29" fill="#c98959"/>
    <path d="M207 246v-52q-15-95 95-104 124-2 115 110l-25 42-7-55q-62 18-128-5l-24 64" fill="#172c2b"/>
    {[231, 260, 292, 325, 357, 385].map((x, i) => <circle key={x} cx={x} cy={133 - Math.sin(i / 2) * 30} r={23 + i % 2 * 5} fill={i === 1 || i === 4 ? '#52645a' : '#172c2b'}/>)}
    <path d="M225 326q20 16 38-1 43 37 83-1 24 19 45-1-4 101-87 104-76-8-79-101" fill="#253933"/>
    <g id="brows"><Brows l={[259, 258]} r={[353, 258]} half={14} color="#253933" brow={brow} browIn={browIn} w={7}/></g>
    <g id="eyes"><Eyes l={[260, 282]} r={[354, 282]} rx={4.5} ry={5} gx={gx} gy={gy} blink={blink} wide={wide} fill="#0d1117"/></g>
    <path d="m302 283-8 34h16" stroke="#a96840" strokeWidth="4" fill="none"/>
    <g id="mouth"><MouthShape m={mouth} s={{cx: 305, cy: 352, hw: 29.5, color: '#f7d6a9', stroke: 5}}/></g>
  </g>
  <g transform={torso}><LimbArm limb={limbL} color={SLEEVE[1]} skin={SKIN[1]}/><LimbArm limb={limbR} color={SLEEVE[1]} skin={SKIN[1]}/></g>
</>;
};

const AishaRig: React.FC<Part & {pose: 'phone' | 'clip' | 'ear'; tilt: number}> = ({wide, head, torso, brow, browIn, blink, gx, gy, mouth, armL, armR, limbL, limbR, id, pose, tilt}) => <>
  <g transform={`rotate(${tilt * .3} 300 520)`}><path d="M96 800V339q-6-225 200-239 208 11 213 239v461" fill="#8e342d"/></g>
  <g id="shoulders" transform={torso}>
    <path d="M70 800V636q8-132 151-162h145q162 30 170 162v164" fill="#292b58"/>
  </g>
  <g id="head" transform={head}>
    <path d="M177 303q-4-151 124-162 136 14 135 164l-29 261q-113 103-237 0z" fill={`url(#${id}-cloth)`}/>
    <path d="M218 276q-4-98 85-105 91 12 88 105v92q-13 88-88 100-76-12-85-100" fill="#aa6850"/>
    <path d="M192 314q87-15 129-124 43 90 87 123l-2-97-103-70-104 85z" fill="#f2a362"/>
    <g id="brows"><Brows l={[262, 296]} r={[351, 296]} half={20} color="#8e342d" brow={brow} browIn={browIn} w={5}/></g>
    <g id="eyes"><Eyes l={[261, 321]} r={[351, 321]} rx={4} ry={5} gx={gx} gy={gy} blink={blink} wide={wide} fill="#0d1117"/></g>
    <path d="m300 334-6 24h13" stroke="#703c38" strokeWidth="4" fill="none" strokeLinecap="round"/>
    <g id="mouth"><MouthShape m={mouth} s={{cx: 303, cy: 387, hw: 26, color: '#703c38'}}/></g>
  </g>
  <g transform={torso}>
    <path d="M211 436q37 91 157 64l-89 119-109-53m230-151 33 157-154 47" fill="#f7ab6b"/>
    <path d="m208 489 71 130 99-110" stroke="#c66b3d" strokeWidth="4" fill="none"/>
    {pose !== 'phone' && <g><path d="M205 610H400l40 190H160z" fill="#efe2c4" stroke="#cdbb95" strokeWidth="4"/><path d="M232 612l-14-120m140 120 18-114" stroke="#cdbb95" strokeWidth="9"/><rect x="262" y="690" width="82" height="60" rx="8" fill="none" stroke="#cdbb95" strokeWidth="4"/></g>}
    <g id="armR" transform={`rotate(${armR} 420 470)`}>
      {pose === 'phone' && <><path d="M407 689q-52-107-19-239l48-2 29 226" fill="#aa6850"/>
        <g transform="rotate(-12 431 431)"><rect x="392" y="345" width="79" height="150" rx="16" fill="#151c30" stroke="#ffc98d" strokeWidth="5"/><rect x="402" y="361" width="59" height="108" rx="6" fill="#535fa4"/><circle cx="431" cy="480" r="5" fill="#c7ceee"/><path d="M445 412q22-6 20 22l-6 43q-5 25-24 5" fill="#bd7b5d"/></g></>}
      {pose === 'clip' && <g transform="rotate(-6 300 700)"><rect x="228" y="610" width="190" height="230" rx="14" fill="#8a5a36" stroke="#5f3b20" strokeWidth="5"/><rect x="246" y="640" width="154" height="186" rx="4" fill="#fffaf0"/><rect x="290" y="598" width="66" height="30" rx="8" fill="#b9bcc4" stroke="#7f838c" strokeWidth="3"/><path d="M262 672h122M262 700h100M262 728h120M262 756h80" stroke="#8c9aa0" strokeWidth="5" strokeLinecap="round"/><ellipse cx="424" cy="780" rx="22" ry="30" fill="#aa6850"/></g>}
      {pose === 'ear' && <g transform="rotate(-6 300 700)"><rect x="228" y="610" width="190" height="230" rx="14" fill="#8a5a36" stroke="#5f3b20" strokeWidth="5"/><rect x="246" y="640" width="154" height="186" rx="4" fill="#fffaf0"/><rect x="290" y="598" width="66" height="30" rx="8" fill="#b9bcc4" stroke="#7f838c" strokeWidth="3"/><path d="M262 672h122M262 700h100M262 728h120" stroke="#8c9aa0" strokeWidth="5" strokeLinecap="round"/><ellipse cx="424" cy="780" rx="22" ry="30" fill="#aa6850"/></g>}
    </g>
    <LimbArm limb={limbL} color={SLEEVE[2]} skin={SKIN[2]}/><LimbArm limb={limbR} color={SLEEVE[2]} skin={SKIN[2]}/>
  </g>
  {pose === 'ear' && <g transform={`${head} translate(-20 40) rotate(18 215 330)`}><rect x="170" y="300" width="56" height="112" rx="14" fill="#151c30" stroke="#ffc98d" strokeWidth="5"/><rect x="178" y="314" width="40" height="76" rx="5" fill="#535fa4"/></g>}
</>;

// Clamp helper kept here for acting code.
export const c01 = clamp01;
