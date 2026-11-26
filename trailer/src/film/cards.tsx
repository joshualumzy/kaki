// Faithful product card redraws, carried over from film-v9 with their labels unchanged.
// Cup is always the actual smiling brand SVG, embedded by media.ts.
import React from 'react';
import {Img} from 'remotion';
import {C, punch} from './primitives';
import {ramp, mix, seg, easeCam} from './motion';
import {events} from './timeline';
import {cupSrc} from './media';

export type Rect = {x: number; y: number; w: number; h: number};
export const box = (r: Rect): React.CSSProperties => ({position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h});
export const blend = (a: Rect, b: Rect, t: number): Rect => ({x: mix(a.x, b.x, t), y: mix(a.y, b.y, t), w: mix(a.w, b.w, t), h: mix(a.h, b.h, t)});
export const NAMES = ['Mei', 'Raj', 'Aisha'];
const fadeIn = (f: number, at: number, n = 6) => ramp(f, at, at + n);
const warm = '#efb96d';
const softWarm = '#ffe6b9';
const muted = '#536569';
const full: React.CSSProperties = {position: 'absolute', inset: 0};
const panel: React.CSSProperties = {
  width: '100%', height: '100%', boxSizing: 'border-box', borderRadius: 28,
  padding: '28px 34px', background: 'linear-gradient(135deg,#fbfff9,#e7f4eb)',
  border: '2px solid #b9d6cb', color: C.ink,
  boxShadow: '0 24px 70px #0007', display: 'flex', flexDirection: 'column', gap: 17,
};
const label: React.CSSProperties = {fontSize: 26, fontWeight: 750, letterSpacing: '.035em', color: C.teal};
const title: React.CSSProperties = {fontSize: 43, fontWeight: 760, lineHeight: 1.08, letterSpacing: '-.035em'};
const whiteBox: React.CSSProperties = {padding: '20px 24px', background: '#fffefa', border: '2px solid #d8e2da', borderRadius: 18};


export const LockIcon: React.FC<{size?: number}> = ({size = 26}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v3"/></svg>;

/** A single, bounded ring on the control being acted on. */
export const TapRipple: React.FC<{f: number; at?: number}> = ({f, at}) => {
  if (at == null || f < at || f > at + 19) return null;
  const t = (f - at) / 19;
  return <span style={{position: 'absolute', inset: -8 - t * 20, border: `5px solid ${warm}`, borderRadius: 23 + t * 12, opacity: 1 - t, pointerEvents: 'none'}}/>;
};

/** Branded cup, with warmth only during its own delivery cue. */
export const RealCup: React.FC<{f: number; size?: number; cue?: number}> = ({f, size = 112, cue}) => {
  const age = cue == null ? 1000 : f - cue;
  const glow = age >= -3 && age <= 29 ? Math.sin(Math.PI * Math.max(0, age + 3) / 32) : 0;
  const bounce = age >= 0 && age < 28 ? Math.sin(age * .3) * 6 * Math.exp(-age / 13) : 0;
  return <div style={{position: 'relative', width: size, height: size, transform: `translateY(${-bounce}px)`}}>
    <div style={{position: 'absolute', inset: '-52%', borderRadius: '50%', background: `radial-gradient(circle,${softWarm}aa,${warm}44 33%,transparent 68%)`, opacity: glow}}/>
    <Img src={cupSrc} width={size} height={size} style={{position: 'relative', objectFit: 'contain', filter: `drop-shadow(0 7px 7px #0004)${glow > 0 ? ` drop-shadow(0 0 ${glow * 16}px ${warm})` : ''}`}}/>
  </div>;
};

const Header: React.FC<{right?: string; children?: React.ReactNode}> = ({right = 'PRIVATE TO YOU', children = 'KAKI (ASSISTANT)'}) => <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, ...label}}><span>{children}</span><span style={{fontSize: 26, fontWeight: 660, letterSpacing: 0}}>{right}</span></div>;
const Pill: React.FC<{children: React.ReactNode; orange?: boolean}> = ({children, orange = false}) => <span style={{display: 'inline-flex', width: 'max-content', padding: '7px 13px', borderRadius: 9, background: orange ? '#ff5a1f18' : '#0b6b5c14', color: orange ? '#a93b11' : C.teal, fontSize: 26, fontWeight: 760}}>{children}</span>;
const Steps: React.FC<{current: number}> = ({current}) => <div style={{display: 'flex', gap: 13, alignItems: 'center', color: muted, fontSize: 26, whiteSpace: 'nowrap'}}>{['1. Accept', '2. Review draft', '3. Published'].map((step, i) => <React.Fragment key={step}>{i > 0 && <span style={{color: '#a1b0ab'}}>→</span>}<span style={{color: i + 1 === current ? C.teal : muted, fontWeight: i + 1 === current ? 760 : 530}}>{step}</span></React.Fragment>)}</div>;
const Button: React.FC<{f: number; at?: number; children: React.ReactNode; subtle?: boolean; disabled?: boolean; prePulse?: boolean}> = ({f, at, children, subtle = false, disabled = false, prePulse = false}) => {
  const pulse = prePulse && at != null && f >= at - 9 && f < at ? Math.sin((f - (at - 9)) / 9 * Math.PI) : 0;
  return <div style={{position: 'relative', transform: `scale(${at != null && f >= at && f < at + 6 ? .93 : 1})`, padding: '16px 25px', width: 'max-content', alignSelf: 'flex-end', borderRadius: 15, background: subtle ? '#e0ebe5' : disabled ? '#678d81' : C.teal, color: subtle ? C.teal : '#fff', fontSize: 33, lineHeight: 1.1, fontWeight: 750, boxShadow: subtle ? undefined : '0 8px 20px #0b6b5c25'}}>{children}{pulse > 0 && <span style={{position: 'absolute', inset: -5 - pulse * 4, border: `3px solid ${warm}`, borderRadius: 20, opacity: pulse * .65}}/>}<TapRipple f={f} at={at}/></div>;
};

export const AnswerCard: React.FC<{f: number}> = ({f: _f}) => <div style={{...panel, gap: 19}}>
  <Header/>
  <div style={{display: 'flex', gap: 16, alignItems: 'center'}}><Pill>ASKED YOU</Pill><span style={{fontSize: 30, color: muted}}>Mei asked you</span><span style={{marginLeft: 'auto', fontSize: 31, color: muted}}>×</span></div>
  <div style={{fontSize: 31, color: '#354b50', lineHeight: 1.2}}>Raj, when does our packaging contract end?</div>
  <div style={{...whiteBox, padding: '26px 27px', background: '#e4eee7', fontSize: 46, fontWeight: 730, lineHeight: 1.16, letterSpacing: '-.025em'}}>31 Mar 2027. It renews automatically unless we give 60 days’ notice.</div>
  <div style={{fontSize: 30, color: muted}}><strong>Sources:</strong> Wiki · Supplier contract</div>
  <div style={{marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 10, color: C.teal, fontSize: 28, fontWeight: 720}}><LockIcon/>Only Raj sees this</div>
</div>;

/** The real Suggested task: the host picks an assignee from a list, then presses Dispatch. */
export const SuggestedCard: React.FC<{f: number}> = ({f}) => {
  const chosen = f >= events.pickChoose, menu = f >= events.pickOpen && f < events.pickChoose + 8;
  const hover = f >= events.pickChoose - 10 ? 1 : 0;
  return <div style={panel}>
    <Header right="MEI’S SCREEN">ACTION PANEL</Header>
    <div style={{display: 'flex', alignItems: 'center', gap: 18}}><Pill orange>SUGGESTED</Pill><div style={title}>Suggested task</div></div>
    <div style={{...whiteBox, borderLeft: `6px solid ${C.orange}`, fontSize: 40, fontWeight: 640, lineHeight: 1.2}}>“I’ll email them this week.”<div style={{fontSize: 27, marginTop: 10, color: muted, fontWeight: 550}}>Raj · said in this meeting</div></div>
    <div style={{fontSize: 32, lineHeight: 1.2, fontWeight: 650}}>Email Jade Packaging about contract renewal</div>
    <div style={{display: 'flex', alignItems: 'center', gap: 20, fontSize: 28, color: muted}}>Assignee
      <div style={{position: 'relative'}}>
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, width: 300, boxSizing: 'border-box', padding: '9px 18px', borderRadius: 12, border: `2px solid ${menu ? C.teal : '#b9ccc3'}`, background: '#fffefa', fontSize: 30, fontWeight: 700, color: chosen ? C.ink : '#8a9a95'}}>{chosen ? 'Raj' : 'Choose…'}<span style={{fontSize: 22, color: muted}}>▾</span></div>
        {menu && <div style={{position: 'absolute', left: 0, top: '100%', marginTop: 6, width: 300, zIndex: 5, borderRadius: 12, border: '2px solid #b9ccc3', background: '#fffefa', boxShadow: '0 14px 30px #0003', overflow: 'hidden', fontSize: 30, fontWeight: 650, color: C.ink}}>
          {NAMES.map((n) => <div key={n} style={{padding: '9px 18px', background: n === 'Raj' && hover ? '#ffe6b9' : undefined}}>{n}</div>)}
        </div>}
      </div>
    </div>
    <div style={{marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}><span style={{fontSize: 27, color: muted}}>Dismiss</span><Button f={f} at={events.sendTap}>Dispatch</Button></div>
  </div>;
};

export const TaskCard: React.FC<{f: number}> = ({f}) => <div style={panel}>
  <Header right="RAJ’S SCREEN">NEEDS YOU NOW</Header>
  <Steps current={1}/>
  <div style={title}>Email Jade Packaging about contract renewal</div>
  <div style={{...whiteBox, fontSize: 33, lineHeight: 1.26}}>“I’ll email them this week.”<div style={{fontSize: 27, marginTop: 13, color: muted}}>Raj · said in this meeting</div></div>
  <div style={{display: 'flex', alignItems: 'center', gap: 12, fontSize: 28, color: C.teal, fontWeight: 650}}><LockIcon/>Only Raj can send this.</div>
  <div style={{marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20}}><span style={{fontSize: 27, color: muted}}>Decline</span><Button f={f} at={events.acceptTap}>Do it for me (Email)</Button></div>
</div>;

export const DraftCard: React.FC<{f: number}> = ({f}) => {
  const addition = "and we'd like to discuss a 12-month price lock.";
  const progress = Math.max(0, Math.min(1, (f - events.editStart) / Math.max(1, events.editEnd - events.editStart)));
  const typing = f >= events.editStart && f < events.editEnd;
  const bodyFocus = f >= events.editStart && f < events.editEnd;
  return <div style={{...panel, gap: 9, padding: '22px 32px'}}>
    <Header right="RAJ’S SCREEN">NEEDS YOU NOW</Header>
    <Steps current={2}/>
    <div style={{fontSize: 36, fontWeight: 760, lineHeight: 1.1}}>Email Jade Packaging</div>
    <div style={{display: 'flex', gap: 15, alignItems: 'center', fontSize: 29}}><span style={{fontWeight: 720}}>To</span><div style={{border: '2px solid #c5d2ca', background: '#fffefa', borderRadius: 10, padding: '5px 15px', flex: 1}}>Jade Packaging</div><span style={{color: muted, fontSize: 26}}>editable</span></div>
    <div style={{fontSize: 29}}><strong>Subject:</strong> Contract renewal</div>
    <div style={{...whiteBox, boxSizing: 'border-box', padding: '12px 22px', borderColor: bodyFocus ? '#c6924d' : '#c5d2ca', boxShadow: bodyFocus ? `0 0 0 3px ${warm}44` : undefined, minHeight: 142}}>
      <div style={{fontSize: 26, fontWeight: 730, color: C.teal, marginBottom: 8}}>Draft body</div>
      <div style={{fontSize: 33, lineHeight: 1.2, letterSpacing: '-.015em'}}>Hi Lin, our contract ends on 31 March{progress > 0 ? ', ' : '.'}<span style={{background: progress > 0 && progress < 1 ? '#ffe0a4' : undefined}}>{addition.slice(0, Math.floor(progress * addition.length))}</span>{typing && <span style={{display: 'inline-block', width: 3, height: 32, background: '#9c5d20', verticalAlign: '-5px', opacity: Math.floor(f / 6) % 2 ? .2 : 1}}/>}</div>
    </div>
    <div style={{marginTop: 'auto', display: 'flex', justifyContent: 'flex-end'}}><Button f={f} at={events.approveTap} disabled={f < events.editEnd} prePulse>Approve &amp; publish</Button></div>
  </div>;
};

export const SentCard: React.FC<{f: number}> = ({f}) => <div style={{...panel, gap: 15, padding: '24px 34px'}}>
  <Header right="RAJ’S SCREEN">NEEDS YOU NOW</Header>
  <Steps current={3}/>
  <div style={{display: 'flex', alignItems: 'center', gap: 22}}><div style={{display: 'grid', placeItems: 'center', width: 78, height: 78, borderRadius: '50%', background: C.teal, color: '#fff', fontSize: 51, transform: `scale(${.86 + .14 * punch(f, events.sent)})`}}>✓</div><div><div style={{fontSize: 51, fontWeight: 780, letterSpacing: '-.025em'}}>Sent</div><div style={{fontSize: 27, color: muted, marginTop: 3}}>completed · synced</div></div></div>
  <div style={{...whiteBox, padding: '16px 24px', fontSize: 29, lineHeight: 1.2}}><div><strong>To</strong> Jade Packaging</div><div style={{marginTop: 8}}><strong>Subject:</strong> Contract renewal</div><div style={{fontSize: 31, marginTop: 16}}>Hi Lin, our contract ends on 31 March, and we'd like to discuss a 12-month price lock.</div></div>
  <div style={{marginTop: 'auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 27, color: C.teal}}><span>Approved by Raj</span><span style={{fontWeight: 740}}>Open live in Mailpit ↗</span></div>
</div>;

/** Real catch-up format: Catch-up: <item>, Now: "<item>", one short point, Meeting only label. */
export const CatchupCard: React.FC<{f: number}> = ({f}) => {
  // the card arrives with its title and the 'Now' line; the one point follows a beat later
  const nowIn = 1, pointIn = 1; // all text is part of the card: it arrives with it
  return <div style={{...panel, gap: 20}}>
    <Header/>
    <div style={{display: 'flex', alignItems: 'center', gap: 18}}><Pill orange>NUDGE</Pill><span style={{marginLeft: 'auto', padding: '8px 16px', border: '2px solid #c5d2ca', borderRadius: 12, color: C.teal, fontSize: 28, fontWeight: 720}}>Meeting only</span></div>
    <div style={title}>Catch-up: Packaging contract</div>
    <div style={{fontSize: 40, lineHeight: 1.2, opacity: nowIn, transform: `translateY(${(1 - nowIn) * 10}px)`}}><strong style={{color: C.teal}}>Now:</strong> “Packaging contract”</div>
    <div style={{...whiteBox, borderLeft: `6px solid ${C.orange}`, opacity: pointIn, transform: `translateY(${(1 - pointIn) * 12}px)`}}>
      <div style={{fontSize: 26, fontWeight: 740, color: muted, marginBottom: 6}}>One point you could add</div>
      <div style={{fontSize: 38, fontWeight: 650, lineHeight: 1.2, letterSpacing: '-.02em'}}>A supplier switch could change how much notice catering needs.</div>
    </div>
    <div style={{marginTop: 'auto', display: 'flex', gap: 12, alignItems: 'center', fontSize: 28, color: C.teal, fontWeight: 690}}><LockIcon/>Only Aisha sees this</div>
  </div>;
};

export const MinutesCard: React.FC<{f: number}> = ({f}) => {
  const published = f >= events.minutesApprove + 12;
  return <div style={{...panel, gap: 13, padding: '24px 34px'}}>
    <Header right="MEI’S SCREEN">NEEDS YOU NOW</Header>
    <Steps current={published ? 3 : 2}/>
    <div style={{...title, fontSize: 40}}>Publish meeting minutes to the team wiki</div>
    <div style={{...whiteBox, padding: '18px 24px', fontSize: 30, lineHeight: 1.25}}><div style={{fontWeight: 780, color: C.teal, marginBottom: 8}}>Decisions</div><div>Renegotiate the packaging contract.</div><div style={{fontWeight: 780, color: C.teal, margin: '18px 0 8px'}}>To-dos</div><div style={{display: 'flex', alignItems: 'center', gap: 16}}><span style={{display: 'grid', placeItems: 'center', width: 36, height: 36, borderRadius: 9, border: `3px solid ${f >= events.minutesTick ? C.teal : '#9fb0aa'}`, background: f >= events.minutesTick ? C.teal : '#fff', color: '#fff', fontSize: 26}}>{f >= events.minutesTick ? '✓' : ''}</span><span><strong>Raj</strong> · Email Jade Packaging about the renewal.</span>{f >= events.minutesTick && <span style={{marginLeft: 'auto', color: C.teal, fontWeight: 740}}>Done</span>}</div></div>
    <div style={{marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between'}}><span style={{fontSize: 28, color: published ? C.teal : muted, fontWeight: published ? 740 : 540}}>{published ? '✓ Published · synced' : 'Draft ready for Mei’s review'}</span>{published ? <span style={{position: 'relative', fontSize: 29, color: C.teal, fontWeight: 750, transform: `scale(${f >= events.wikiTap && f < events.wikiTap + 6 ? .94 : 1})`}}>Open meeting minutes in Wiki ↗<TapRipple f={f} at={events.wikiTap}/></span> : <Button f={f} at={events.minutesApprove}>Approve &amp; publish</Button>}</div>
  </div>;
};

/** The published minutes as a page in the team wiki. */
export const WikiPage: React.FC = () => <div style={{...panel, padding: 0, gap: 0, overflow: 'hidden', background: '#fdfefc'}}>
  <div style={{display: 'flex', alignItems: 'center', gap: 18, padding: '15px 34px', background: C.teal, color: '#fff', fontSize: 27, fontWeight: 720}}><span>Wiki.js</span><span style={{fontWeight: 520, opacity: .85}}>Meetings / Monday team meeting</span><span style={{marginLeft: 'auto', fontWeight: 520, opacity: .9}}>Team wiki</span></div>
  <div style={{padding: '24px 40px', display: 'flex', flexDirection: 'column', gap: 14, flex: 1}}>
    <div style={{...title, fontSize: 46}}>Monday team meeting · minutes</div>
    <div style={{...whiteBox, padding: '18px 24px', fontSize: 31, lineHeight: 1.28}}><div style={{fontWeight: 780, color: C.teal, marginBottom: 6}}>Decisions</div><div>Renegotiate the packaging contract.</div><div style={{fontWeight: 780, color: C.teal, margin: '16px 0 6px'}}>To-dos</div><div><strong>Raj</strong> · Email Jade Packaging about the renewal.</div></div>
    <div style={{marginTop: 'auto', fontSize: 27, color: C.teal, fontWeight: 700}}>✓ Published by Mei · synced</div>
  </div>
</div>;

const iconProps = {width: 52, height: 52, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const};
export const ClockIcon = () => <svg {...iconProps}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>;
export const CardIcon = () => <svg {...iconProps}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M7 10h10M7 14h5"/><path d="M17 15.5v-1a1 1 0 0 1 2 0v1m-2.4 0h2.8v2h-2.8z" strokeWidth="1.4"/></svg>;
export const CheckIcon = () => <svg {...iconProps}><rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8 12.5 3 3 5-6"/></svg>;
const MailIcon = () => <svg {...iconProps}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>;
const CalIcon = () => <svg {...iconProps}><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4m6-4v4"/></svg>;
const ChatIcon = () => <svg {...iconProps}><path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-5 4v-4a3 3 0 0 1-2-3z"/></svg>;
const GitIcon = () => <svg {...iconProps}><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 8.2v7.6M18 11.2c0 4-6 3-11 5"/></svg>;
const WikiIcon = () => <svg {...iconProps}><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h6"/></svg>;

export const MicIcon: React.FC<{muted: boolean; size?: number}> = ({muted, size = 30}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>{muted && <path d="M4 4l16 16" stroke="#ff7a5c" strokeWidth="2.6"/>}</svg>;

/** Card slot in speaker view: it grows in place beside the speaker, after the tiles have settled, with a short warm trail from the speaker's cup. */
export const CARD_SLOT = {x: 590, y: 175, w: 1180, h: 600, scale: .88};
export const CardIn: React.FC<{f: number; at: number; from: [number, number]; trail?: boolean; children: React.ReactNode}> = ({f, at, from, trail = true, children}) => {
  const age = f - at;
  const e = seg(f, at, at + 20, easeCam);
  const line = age >= 0 && age < 17 ? Math.sin(age / 17 * Math.PI) : 0;
  const tx = CARD_SLOT.x + 44, ty = CARD_SLOT.y + CARD_SLOT.h * CARD_SLOT.scale - 56;
  const d = `M${from[0]} ${from[1]} C${from[0] + 6} ${from[1] - 60} ${tx - 24} ${ty + 50} ${tx} ${ty}`;
  return <>
    {trail && line > 0 && <svg width="1920" height="1080" style={{...full, pointerEvents: 'none', overflow: 'visible', opacity: line}}><defs><linearGradient id="v10-cup-trail"><stop stopColor={warm} stopOpacity="0"/><stop offset=".6" stopColor={softWarm}/><stop offset="1" stopColor={warm} stopOpacity="0"/></linearGradient></defs><path d={d} fill="none" stroke={warm} strokeWidth="22" opacity=".16"/><path d={d} fill="none" stroke="url(#v10-cup-trail)" strokeWidth="5" strokeLinecap="round" strokeDasharray="170 230" strokeDashoffset={-age * 24}/></svg>}
    <div style={{position: 'absolute', left: CARD_SLOT.x, top: CARD_SLOT.y, width: CARD_SLOT.w * CARD_SLOT.scale, height: CARD_SLOT.h * CARD_SLOT.scale, opacity: ramp(f, at, at + 12), transform: `translateY(${(1 - e) * 22}px) scale(${.95 + .05 * e})`}}>
      <div style={{width: CARD_SLOT.w, height: CARD_SLOT.h, transformOrigin: '0 0', transform: `scale(${CARD_SLOT.scale})`}}>{children}</div>
    </div>
  </>;
};

/** A postage stamp: perforated edge, a framed Kaki cup, a small value mark. */
const Stamp: React.FC<{w: number; h: number; style?: React.CSSProperties}> = ({w, h, style}) => {
  const id = `stamp${React.useId().replace(/\W/g, '')}`;
  const holesX = Array.from({length: 9}, (_, i) => i * 12.5), holesY = Array.from({length: 11}, (_, i) => i * 12);
  return <div style={{width: w, height: h, filter: 'drop-shadow(0 2px 2px #0005)', ...style}}>
    <svg width={w} height={h} viewBox="0 0 100 120" style={{position: 'absolute', inset: 0}}>
      <defs><mask id={id}><rect width="100" height="120" fill="#fff"/>{holesX.map((x) => <React.Fragment key={x}><circle cx={x} cy={0} r={3.7} fill="#000"/><circle cx={x} cy={120} r={3.7} fill="#000"/></React.Fragment>)}{holesY.map((y) => <React.Fragment key={y}><circle cx={0} cy={y} r={3.7} fill="#000"/><circle cx={100} cy={y} r={3.7} fill="#000"/></React.Fragment>)}</mask></defs>
      <g mask={`url(#${id})`}><rect width="100" height="120" fill="#fff4de"/><rect x="9" y="9" width="82" height="102" rx="3" fill="#f6dcbd" stroke="#b8664a" strokeWidth="2"/></g>
      <text x="50" y="104" textAnchor="middle" fontSize="12" fontWeight="800" fill="#8a3b22" fontFamily="sans-serif" letterSpacing="1.5">KAKI</text>
    </svg>
    <Img src={cupSrc} width={w * .62} height={w * .62} style={{position: 'absolute', left: w * .19, top: h * .13, objectFit: 'contain'}}/>
  </div>;
};

/** An envelope: flapDeg 0 is closed, 170 is wide open. sides folds the side flaps in (0 = open, 1 = folded). */
export const EnvelopeBody: React.FC<{w: number; h: number; flapDeg?: number; sides?: number; tag?: string; paper?: number; children?: React.ReactNode}> = ({w, h, flapDeg = 0, sides = 1, tag, paper = 1, children}) => <div style={{position: 'relative', width: w, height: h, perspective: 900, filter: 'drop-shadow(0 12px 16px #0006)'}}>
  <div style={{position: 'absolute', inset: 0, borderRadius: 10, background: '#f4e9cf', border: '3px solid #cbb78d', opacity: paper}}/>
  <div style={{position: 'absolute', inset: 0, zIndex: flapDeg > 90 ? 0 : 4, transformOrigin: '50% 0', transform: `rotateX(${-flapDeg}deg)`, background: flapDeg > 90 ? '#d9c697' : '#e2cfa3', clipPath: 'polygon(0 0, 100% 0, 50% 64%)'}}/>
  {children}
  <div style={{position: 'absolute', inset: 0, zIndex: 2, background: '#e8d8b3', clipPath: `polygon(0 0, ${50 * sides}% 54%, 0 100%)`}}/>
  <div style={{position: 'absolute', inset: 0, zIndex: 2, background: '#e8d8b3', clipPath: `polygon(100% 0, ${100 - 50 * sides}% 54%, 100% 100%)`}}/>
  <div style={{position: 'absolute', inset: 0, zIndex: 3, background: '#efe0bb', clipPath: 'polygon(0 100%, 50% 46%, 100% 100%)'}}/>
  {tag && <div style={{position: 'absolute', zIndex: 5, left: 0, right: 0, bottom: h * .1, textAlign: 'center', fontSize: Math.max(14, h * .1), fontWeight: 750, color: '#5b4a2c', letterSpacing: '.02em'}}>{tag}<div style={{margin: '6px auto 0', width: '46%', height: 3, background: '#b8a57c'}}/></div>}
  {tag && <Stamp w={h * .21} h={h * .26} style={{position: 'absolute', zIndex: 5, right: h * .07, top: h * .09, transform: 'rotate(3deg)'}}/>}
</div>;

export const EndCard: React.FC<{f: number}> = ({f}) => {
  const local = f - events.endCard;
  const p = punch(local, 0, 18);
  return <div style={{...full, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', background: '#0d1117', color: '#fff4da', opacity: ramp(local, 0, 18)}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 29, transform: `translateY(${(1 - p) * 24}px)`}}><RealCup f={local} size={240}/><span style={{fontSize: 196, fontWeight: 790, letterSpacing: '-.065em', lineHeight: 1}}>Kaki</span></div>
    <div style={{marginTop: 58, fontSize: 43, fontWeight: 550, letterSpacing: '-.025em', color: '#eee4cf'}}>github.com/IT5007-2610/it5007-courseproject-group-14</div>
  </div>;
};
