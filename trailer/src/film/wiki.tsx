// The team wiki page on the laptop screen: earlier Mondays' minutes, and this Monday's joining at the top.
import React from 'react';
import {AbsoluteFill} from 'remotion';
import {C} from './primitives';
import {events as E} from './timeline';
import {mix, ramp, seg, settle} from './motion';
import {APP_BG} from './stage';

const ROWS = ['Monday team meeting · 7 Dec', 'Monday team meeting · 30 Nov', 'Monday team meeting · 23 Nov', 'Monday team meeting · 16 Nov'];
const NEW = 'Monday team meeting · 14 Dec';
const ROW_H = 124;
export const WikiScreenContent: React.FC<{f: number}> = ({f}) => {
  const s = seg(f, E.rowIn, E.rowIn + 24);
  const entered = ramp(f, E.wikiSwap + 8, E.wikiSwap + 44);
  const nudge = s; // older rows move down one row height in step with the new row
  const hl = 1 - seg(f, E.rowIn + 8, E.rowIn + 44);
  const row = (text: string, y: number, key: string, bg = '#ffffff', alpha = 1) => <div key={key} style={{position: 'absolute', left: 0, right: 0, top: y, height: ROW_H - 14, display: 'flex', alignItems: 'center', gap: 28, padding: '0 40px', borderRadius: 18, background: bg, border: '2px solid #d8e2da', boxSizing: 'border-box', opacity: alpha, fontSize: 44, fontWeight: 620, color: C.ink}}>
    <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke={C.teal} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h6"/></svg>{text}
  </div>;
  return <AbsoluteFill style={{background: '#f2f6f3', color: C.ink}}>
    <div style={{height: 92, background: C.teal, color: '#fff', display: 'flex', alignItems: 'center', gap: 30, padding: '0 64px', fontSize: 38, fontWeight: 720}}><span>Wiki.js</span><span style={{fontWeight: 520, opacity: .88}}>Meetings</span><span style={{marginLeft: 'auto', fontWeight: 520, opacity: .9}}>Team wiki</span></div>
    <div style={{position: 'absolute', left: 260, right: 260, top: 150}}>
      <div style={{fontSize: 70, fontWeight: 780, letterSpacing: '-.035em', marginBottom: 36}}>Meeting minutes</div>
      <div style={{position: 'relative', height: ROW_H * 5, overflow: 'hidden'}}>
        {ROWS.map((r, i) => row(r, mix(0, ROW_H, nudge) + i * ROW_H, r, '#ffffff', entered * ramp(f, E.wikiSwap + 8 + i * 4, E.wikiSwap + 8 + i * 4 + 6)))}
        {f >= E.rowIn && row(NEW, mix(-ROW_H, 0, s), 'new', `rgb(255,${mix(255, 233, hl)},${mix(255, 168, hl)})`, seg(f, E.rowIn, E.rowIn + 10))}
      </div>
    </div>
  </AbsoluteFill>;
};
void seg; void APP_BG;
