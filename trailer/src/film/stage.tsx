// The call UI: tiles, controls, cards. Shared by the full-frame call and the laptop screen inside the world.
import React from 'react';
import {C} from './primitives';
import {RigPortrait} from './rig';
import {aishaShift, gridRig, isMuted} from './act';
import {AnswerCard, CARD_SLOT, CardIn, CatchupCard, DraftCard, EnvelopeBody, MicIcon, MinutesCard, NAMES, Rect, RealCup, SentCard, SuggestedCard, TaskCard, blend, box} from './cards';
import {events as E, line, lineAt} from './timeline';
import {clamp01, cubic, easeCam, mix, ramp, seg, settle} from './motion';

export const GRID: Rect[] = [{x: 100, y: 150, w: 480, h: 650}, {x: 720, y: 150, w: 480, h: 650}, {x: 1340, y: 150, w: 480, h: 650}];
export const PERSON: Rect = {x: 80, y: 140, w: 470, h: 650};
const THUMB: Rect[] = [{x: 1650, y: 140, w: 240, h: 300}, {x: 1650, y: 540, w: 240, h: 300}];
/** Task beat: the three tiles sit in a tidy column at the left so the card never crosses a face. */
const COLUMN: Rect[] = [{x: 50, y: 150, w: 210, h: 280}, {x: 50, y: 450, w: 210, h: 280}, {x: 50, y: 750, w: 210, h: 280}];
/** Raj's small tile on Mei's screen (Mei large): where the dispatched task lands. */
export const RAJ_TILE_C: [number, number] = [THUMB[0].x + THUMB[0].w / 2, THUMB[0].y + THUMB[0].h / 2];
export const layoutRects = (focus: number): Rect[] => focus < 0 ? GRID : focus === 3 ? COLUMN : [0, 1, 2].map((w) => w === focus ? PERSON : THUMB[[0, 1, 2].filter((x) => x !== focus).indexOf(w)]);

/** Frames each tile move takes. Everything on the call stage waits for the move to finish. */
export const MOVE = 54;
type Seg = {from: number; to: number; kind: 'focus' | 'column' | 'grow'; focus: number; enter: boolean};
const SEGS: Seg[] = [
  {from: E.answerLayout, to: E.answerLayout + MOVE, kind: 'focus', focus: 1, enter: true}, {from: E.answerOut + 6, to: E.answerOut + 6 + MOVE, kind: 'focus', focus: 1, enter: false},
  // Mei's screen: Mei large, Raj and Aisha small
  {from: E.lift - 44, to: E.lift - 44 + MOVE, kind: 'focus', focus: 0, enter: true},
  // the task lands in Raj's small tile, which grows into his own view while Mei's tile shrinks to its place (Raj's screen, as in his answer moment)
  {from: E.chipLand + 4, to: E.taskIn - 2, kind: 'grow', focus: 1, enter: true}, {from: E.sent + 88, to: E.sent + 88 + MOVE, kind: 'focus', focus: 1, enter: false},
  {from: E.aishaLayout, to: E.aishaLayout + MOVE, kind: 'focus', focus: 2, enter: true}, {from: E.catchupOut + 10, to: E.catchupOut + 10 + MOVE, kind: 'focus', focus: 2, enter: false},
];
const sub = (u: number, a: number, b: number) => easeCam(clamp01((u - a) / (b - a)));
const TRANSIT = {w: 170, h: 226}, LANE_TOP = 24, LANE_BOT = 1080 - 24 - TRANSIT.h;
const rectAround = (cx: number, cy: number, w: number, h: number): Rect => ({x: cx - w / 2, y: cy - h / 2, w, h});
const centreOf = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];
/**
 * Grid to a focused speaker (and back, run backwards) with no overlap at any moment: everyone shrinks in place, the two others
 * leave by their own lane (top or bottom edge) while the speaker crosses the middle row, then thumbnails drop into their slots and the speaker grows.
 */
const focusMove = (focus: number, u: number): Rect[] => {
  const T = layoutRects(focus);
  return GRID.map((g, i) => {
    const gc = centreOf(g), tc = centreOf(T[i]);
    const laneY = i === focus ? gc[1] : T[i].y < 400 ? LANE_TOP + TRANSIT.h / 2 : LANE_BOT + TRANSIT.h / 2;
    const shrink = sub(u, 0, .3), toLane = sub(u, .22, .5), across = sub(u, .45, .75), land = sub(u, .7, 1);
    const w = mix(mix(g.w, TRANSIT.w, shrink), T[i].w, land), h = mix(mix(g.h, TRANSIT.h, shrink), T[i].h, land);
    return rectAround(mix(gc[0], tc[0], across), mix(mix(gc[1], laneY, toLane), tc[1], land), w, h);
  });
};
/** Grid to the left column (and back): shrink in place, move to its row, then slide left. */
const columnMove = (u: number): Rect[] => GRID.map((g, i) => {
  const gc = centreOf(g), c = COLUMN[i], cc = centreOf(c);
  const shrink = sub(u, 0, .3), down = sub(u, .25, .6), left = sub(u, .55, 1);
  return rectAround(mix(gc[0], cc[0], left), mix(gc[1], cc[1], down), mix(g.w, c.w, shrink), mix(g.h, c.h, shrink));
});
const segAt = (f: number): Seg | undefined => {let s: Seg | undefined; for (const x of SEGS) if (f >= x.from) s = x; return s;};
const segU = (f: number, s: Seg) => { const p = clamp01((f - s.from) / (s.to - s.from)); return s.enter ? p : 1 - p; };
export const rectsAt = (f: number): Rect[] => {
  const s = segAt(f);
  if (!s) return GRID;
  const u = segU(f, s);
  if (s.kind === 'grow') {const T = layoutRects(s.focus), e = easeCam(u); return layoutRects(0).map((c, i) => ({x: mix(c.x, T[i].x, e), y: mix(c.y, T[i].y, e), w: mix(c.w, T[i].w, e), h: mix(c.h, T[i].h, e)}));}
  return s.kind === 'column' ? columnMove(u) : focusMove(s.focus, u);
};
/** The call bar steps aside while a tile slides across it. */
export const controlsAlpha = (f: number): number => {
  const s = segAt(f);
  if (!s) return 1;
  if (s.kind === 'grow') {const u = segU(f, s); return 1 - sub(u, .15, .35) * (1 - sub(u, .8, 1));}
  const u = segU(f, s);
  return s.kind === 'column' ? 1 - sub(u, .3, .5) * (1 - sub(u, .92, 1)) : 1 - sub(u, .1, .28) * (1 - sub(u, .82, .96));
};
/** The cup sits beside its tile, never on the portrait: to the right if there is room, otherwise slipping under the tile's lower right corner. */
export const cupBox = (r: Rect): {x: number; y: number; size: number} => {
  const size = Math.max(62, Math.min(84, r.w * .175)), need = size + 10, space = 1920 - (r.x + r.w);
  const t = clamp01((need - space) / (need * .5));
  return {size, x: mix(r.x + r.w + 6, r.x + r.w - size, t), y: mix(r.y + r.h - size, r.y + r.h + 6, t)};
};
const speaker = (f: number) => {const v = lineAt(f)?.voice; return v === 'mei' ? 0 : v === 'raj' ? 1 : v === 'aisha' ? 2 : -1;};
const halo = (f: number, at: number, dur: number) => ramp(f, at, at + 10) * (1 - ramp(f, at + dur, at + dur + 14)) * (.45 + .15 * Math.sin((f - at) / 9));

const Tile: React.FC<{who: number; f: number; rect: Rect; cupAt?: number; haloV?: number; cueAt?: number; dark?: number}> = ({who, f, rect, cupAt, haloV = 0, cueAt, dark = 0}) => {
  const sh = who === 2 ? aishaShift(f) : {x: 0, rot: 0};
  const rig = {...gridRig(who, f), shiftX: sh.x, shiftRot: sh.rot}, active = speaker(f) === who;
  const lean = who === 2 ? seg(f, E.lean, E.lean + 10) * (1 - seg(f, line('aisha2').endFrame, line('aisha2').endFrame + 16)) : 0;
  const k = Math.max(.75, rect.w / 480), cup = cupBox(rect);
  const drop = cupAt == null || f < cupAt ? null : settle(f - cupAt);
  // Raj's tile takes the task: it pulses twice and carries a small "New task" note until the cut to his screen
  const taking = who === 1 && f >= E.rajGlow && f < E.taskIn, age = f - E.rajGlow;
  const pulse = taking ? Math.max(0, Math.sin(age * Math.PI / 14)) : 0, noteIn = taking ? settle(age - 4) : 0;
  return <div style={{...box(rect), transform: taking ? `scale(${1 + .05 * pulse})` : undefined}}>
    <div style={{position: 'absolute', inset: 0, borderRadius: 28, overflow: 'hidden', border: `3px solid ${active ? C.orange : '#ffffff35'}`, boxSizing: 'border-box', boxShadow: '0 18px 48px #0004'}}>
      <div style={{position: 'absolute', inset: 0, transformOrigin: '50% 100%', transform: `translate(0,${-4 * lean}px) scale(${1 + .02 * lean})`}}><RigPortrait who={who} f={f} rig={rig}/></div>
    </div>
    {taking && <div style={{position: 'absolute', inset: -6, borderRadius: 34, border: `5px solid ${C.orange}`, opacity: .35 + .65 * pulse, pointerEvents: 'none'}}/>}
    {taking && noteIn > 0 && <div style={{position: 'absolute', right: 10, bottom: 14, padding: '6px 14px', borderRadius: 10, background: '#ffd28a', color: '#0d1117', fontSize: 22, fontWeight: 760, whiteSpace: 'nowrap', transform: `scale(${noteIn})`, transformOrigin: '100% 100%', boxShadow: '0 4px 12px #0006'}}>New task</div>}
    <div style={{position: 'absolute', top: 17, left: 17, display: 'flex', alignItems: 'center', gap: 12, padding: `${8 * k}px ${16 * k}px`, borderRadius: 12, background: '#0d1117e8', color: 'white', fontSize: 28 * k, fontWeight: 710}}>{NAMES[who]}{who === 0 && <span style={{fontSize: 22 * k, fontWeight: 700, color: '#0d1117', background: '#ffd28a', borderRadius: 8, padding: '2px 10px'}}>Host</span>}</div>
    <div style={{position: 'absolute', bottom: 16, left: 17, width: 40 * k, height: 40 * k, borderRadius: '50%', background: '#0d1117e8', display: 'grid', placeItems: 'center', color: isMuted(who, f) ? '#ff9a7c' : '#dfe8e5'}}><MicIcon muted={isMuted(who, f)} size={26 * k}/></div>
    {dark > 0 && <div style={{position: 'absolute', inset: 0, borderRadius: 28, background: '#0b0f14', opacity: dark, display: 'grid', placeItems: 'center', fontSize: 40 * k, fontWeight: 700, color: '#6f7f84'}}>{NAMES[who][0]}</div>}
    {drop != null && <div style={{position: 'absolute', left: cup.x - rect.x, top: cup.y - rect.y, opacity: clamp01((f - (cupAt ?? 0)) / 4), transform: `translateY(${-30 * (1 - drop)}px)`, filter: dark > 0 ? `brightness(${1 - .93 * dark})` : undefined}}>
      {haloV > 0 && <div style={{position: 'absolute', inset: '-70%', borderRadius: '50%', background: 'radial-gradient(circle,#ffe6b9aa,#efb96d44 38%,transparent 68%)', opacity: haloV}}/>}
      <RealCup f={f} size={cup.size} cue={cueAt}/>
    </div>}
  </div>;
};

export const CallControls: React.FC<{ended?: boolean; opacity?: number; f?: number}> = ({ended = false, opacity = 1, f = -999}) => <div style={{position: 'absolute', left: 0, right: 0, top: 826, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 16, opacity, visibility: opacity > 0 ? 'visible' : 'hidden'}}>
  {ended ? <div style={{color: '#b7c7c5', fontSize: 27}}>Meeting ended</div> : <>
    <div style={{border: '1px solid #ffffff25', borderRadius: 30, padding: '13px 24px', background: '#ffffff0b', fontSize: 23, color: '#cbdad5'}}>Turn mic off</div>
    <div style={{border: '1px solid #ffffff25', borderRadius: 30, padding: '13px 24px', background: '#ffffff0b', fontSize: 23, color: '#cbdad5'}}>Turn camera off</div>
    <div style={{position: 'relative', borderRadius: 30, padding: '14px 27px', background: '#a9463b', fontSize: 23, transform: `scale(${f >= E.endTap && f < E.endTap + 6 ? .94 : 1})`}}>End for everyone{f >= E.endTap && f < E.endTap + 20 && <span style={{position: 'absolute', inset: -8 - (f - E.endTap), border: '4px solid #efb96d', borderRadius: 40, opacity: 1 - (f - E.endTap) / 20}}/>}</div>
  </>}
</div>;

export const APP_BG = 'radial-gradient(ellipse at 20% 30%,#0b6b5c99,transparent 65%),radial-gradient(ellipse at 95% 5%,#4652e655,transparent 60%),#0d1117';

/** The three tiles (and call controls) at frame f, laid out by the shared layout timeline. */
export const Tiles: React.FC<{f: number; cups: boolean; rects?: Rect[]; fadeTiles?: number; dark?: number[]}> = ({f, cups, rects, fadeTiles = 0, dark}) => {
  const rs = rects ?? rectsAt(f);
  return <>{[0, 1, 2].map((who) => <div key={who} style={{opacity: 1 - fadeTiles}}><Tile who={who} f={f} rect={rs[who]} cupAt={cups ? E.cup[who] : undefined}
    dark={dark ? ramp(f, dark[who], dark[who] + 10) : 0} haloV={who === 1 ? Math.max(halo(f, E.answerGlow, 80), halo(f, E.rajGlow, 70)) : who === 2 ? halo(f, E.glow3, 90) : 0} cueAt={who === 1 ? (f >= E.rajGlow ? E.rajGlow : E.answerGlow) : who === 2 ? E.glow3 : undefined}/></div>)}</>;
};

/** The task as a small chip: what flies into Raj's tile after Dispatch. */
const TaskChip: React.FC = () => <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px', borderRadius: 40, background: '#fbfff9', border: '2px solid #b9d6cb', boxShadow: '0 10px 30px #0007', color: C.ink, fontSize: 30, fontWeight: 720, whiteSpace: 'nowrap'}}><span style={{width: 26, height: 26, borderRadius: 8, border: `3px solid ${C.teal}`}}/>Email Jade Packaging</div>;
const SLOT_C: [number, number] = [CARD_SLOT.x + CARD_SLOT.w * CARD_SLOT.scale / 2, CARD_SLOT.y + CARD_SLOT.h * CARD_SLOT.scale / 2];
const placeCard = (c: [number, number], s: number, children: React.ReactNode, opacity = 1, rot = 0) =>
  <div style={{position: 'absolute', left: c[0] - 590, top: c[1] - 300, width: 1180, height: 600, transform: `rotate(${rot}deg) scale(${s})`, opacity}}>{children}</div>;
const ENV_C: [number, number] = [1010, 470];

/** Scene 7: one task card, moved by hand across the call: caption lifts off into the Suggested task, Mei picks Raj and presses Dispatch, it glides to Raj, becomes an email, folds into an envelope. */
const AgreedAndSent: React.FC<{f: number}> = ({f}) => {
  if (f < E.lift) return null;
  const out: React.ReactNode[] = [];
  // 1. the Suggested task opens in the slot on Mei's screen, the same way Raj's task card opens on his
  if (f < E.glideStart) {
    const u = seg(f, E.lift, E.lift + 10, easeCam);
    out.push(<React.Fragment key="s">{placeCard(SLOT_C, mix(.93, .88, u), <SuggestedCard f={f}/>, ramp(f, E.lift, E.lift + 10))}</React.Fragment>);
  } else if (f < E.taskIn) {
    // 2. Dispatch: the card shrinks into a small task chip that flies into Raj's tile and is taken up by it (the tile pulses, see Tile)
    const u = clamp01((f - E.glideStart) / (E.chipLand - E.glideStart)), flight = easeCam(u);
    const at = cubic(SLOT_C, [1300, 640], [1640, 520], RAJ_TILE_C, flight);
    const cardA = 1 - sub(u, .22, .42), chipA = sub(u, .22, .42) * (1 - sub(f, E.chipLand, E.chipLand + 8));
    if (cardA > 0) out.push(<React.Fragment key="g">{placeCard(at, mix(.88, .26, sub(u, 0, .42)), <SuggestedCard f={f}/>, cardA)}</React.Fragment>);
    if (chipA > 0) out.push(<div key="chip" style={{position: 'absolute', left: at[0], top: at[1], opacity: chipA, transform: `translate(-50%,-50%) scale(${mix(.95, .5, sub(u, .35, 1)) * (1 - .6 * sub(f, E.chipLand, E.chipLand + 8))})`}}><TaskChip/></div>);
  } else {
    // 3. the cut to Raj's screen: Raj large, Mei and Aisha small, with the task card open in the slot
    const c = SLOT_C, u = seg(f, E.taskIn, E.taskIn + 10, easeCam), s = mix(.93, .88, u);
    // the task card clears first, then the draft opens in the same place (never both at once)
    const taskA = 1 - ramp(f, E.draftIn - 6, E.draftIn), draftT = ramp(f, E.draftIn, E.draftIn + 8);
    const fold = seg(f, E.foldStart, E.foldStart + 10, easeCam);
    if (f < E.foldStart) {
      if (taskA > 0) out.push(<React.Fragment key="t">{placeCard(c, s, <TaskCard f={f}/>, taskA)}</React.Fragment>);
      if (f >= E.draftIn) out.push(<React.Fragment key="d">{placeCard(c, s, <DraftCard f={f}/>, draftT)}</React.Fragment>);
    }
    if (f >= E.foldStart && f < E.flyEnd + 4) {
      const W = mix(1038, 520, fold), H = mix(528, 340, fold);
      const cx = mix(SLOT_C[0], ENV_C[0], fold), cy = mix(SLOT_C[1], ENV_C[1], fold);
      const sides = seg(f, E.foldStart + 10, E.foldStart + 16), flap = 170 * (1 - seg(f, E.foldStart + 14, E.foldStart + 24));
      const dip = 8 * seg(f, E.fly - 6, E.fly, easeCam);
      const p = seg(f, E.fly, E.flyEnd, easeCam);
      const pos = (q: number): [number, number] => cubic([ENV_C[0], ENV_C[1] + dip], [1150, 290], [1750, -230], [2350, -330], clamp01(q));
      const env = (q: number, alpha: number, key: string) => {
        const [x, y] = f < E.fly ? [cx, cy + dip] : pos(q);
        const sc = f < E.fly ? 1 : mix(1, .4, clamp01(q));
        // the address and stamp are written only once the flap has closed
        return <div key={key} style={{position: 'absolute', left: x - 260, top: y - 170, opacity: alpha, transform: `rotate(${f < E.fly ? 0 : 12 * clamp01(q)}deg) scale(${sc})`}}><EnvelopeBody w={520} h={340} flapDeg={flap} sides={sides} tag={f >= E.foldStart + 24 ? 'Jade Packaging' : undefined}/></div>;
      };
      out.push(<React.Fragment key="paper">
        {f < E.foldStart + 12 && <div style={{position: 'absolute', left: cx - W / 2, top: cy - H / 2, width: W, height: H, borderRadius: 14, background: '#f4e9cf', border: '3px solid #cbb78d', overflow: 'hidden', boxShadow: '0 20px 50px #0006'}}>
          <div style={{position: 'absolute', left: W / 2 - 590, top: H / 2 - 300, width: 1180, height: 600, transform: `scale(${.88})`, transformOrigin: '590px 300px', opacity: 1 - seg(f, E.foldStart, E.foldStart + 5)}}><DraftCard f={f}/></div>
        </div>}
        {f >= E.foldStart + 5 && (f < E.fly ? env(0, ramp(f, E.foldStart + 5, E.foldStart + 9), 'e') : env(p, 1, 'e'))}
      </React.Fragment>);
    }
    if (f >= E.sent) {
      const sc = settle(f - E.sent);
      out.push(<div key="sent" style={{position: 'absolute', left: CARD_SLOT.x, top: CARD_SLOT.y + (1 - sc) * 34, width: 1180, height: 600, transformOrigin: '0 0', transform: `scale(${CARD_SLOT.scale})`, opacity: ramp(f, E.sent, E.sent + 6) * (1 - ramp(f, E.sent + 74, E.sent + 88))}}><SentCard f={f}/></div>);
    }
  }
  return <>{out}</>;
};

/** Everything on the call stage for the scenes S3-S8 and S11. */
export const CallScene: React.FC<{f: number; cups: boolean}> = ({f, cups}) => {
  const exit = (at: number) => 1 - ramp(f, at, at + 12);
  const cupFrom = (who: number): [number, number] => {const c = cupBox(layoutRects(who)[who]); return [c.x + c.size / 2, c.y + c.size / 2];};
  return <>
    <Tiles f={f} cups={cups}/>
    <CallControls opacity={controlsAlpha(f)}/>
    {f >= E.answerIn && f < E.answerOut + 12 && <div style={{opacity: exit(E.answerOut - 4)}}><CardIn f={f} at={E.answerIn} from={cupFrom(1)}><AnswerCard f={f}/></CardIn></div>}
    {f >= E.catchupIn && f < E.catchupOut + 20 && <div style={{opacity: exit(E.catchupOut - 2)}}><CardIn f={f} at={E.catchupIn} from={cupFrom(2)}><CatchupCard f={f}/></CardIn></div>}
    {f >= E.lift && f < E.s7End + 10 && <AgreedAndSent f={f}/>}
  </>;
};

const colorOf = (v?: string) => v === 'mei' ? '#fdb792' : v === 'raj' ? '#a1e3ca' : '#dfc4ff';
/** Dialogue caption (what the character says). Raj's line lifts off to become the task card. */
export const Caption: React.FC<{f: number}> = ({f}) => {
  const raj3 = line('raj3');
  // Raj's line stays up, once, from the moment he says it until the Suggested task opens (the narrator speaks in between)
  const l = f >= raj3.startFrame && f < E.lift + 14 ? raj3 : lineAt(f);
  if (!l || l.voice === 'narrator' || !l.text) return null;
  const liftOut = l.id === 'raj3' ? 1 - ramp(f, E.lift, E.lift + 14) : 1;
  return <div style={{position: 'absolute', left: '50%', bottom: 26, transform: 'translateX(-50%)', width: 'max-content', maxWidth: 1530, boxSizing: 'border-box', padding: '13px 24px', borderRadius: 13, background: '#0d1117ed', boxShadow: '0 5px 18px #0004', fontSize: 31, lineHeight: 1.22, fontWeight: 550, textAlign: 'center', color: '#fff9ed', opacity: ramp(f, l.startFrame, l.startFrame + 3) * liftOut}}><span style={{fontWeight: 760, color: colorOf(l.voice), marginRight: 15}}>{l.speaker}</span>“{l.text}”</div>;
};
