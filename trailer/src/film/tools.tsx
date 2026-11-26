// Scene 9: four small app windows in a calm row. Each receives a different outcome of this meeting, one after another, on the spoken word for its tool.
import React from 'react';
import {C} from './primitives';
import {events as E} from './timeline';
import {easeCam, easeOut, ramp, seg} from './motion';
import {RealCup} from './cards';

const W = 430, H = 600, Y = 220, XS = [49, 513, 977, 1441];
const grey = '#dfe6e2', ink = C.ink, teal = C.teal;
const bars = (n: number, w = 200) => <>{Array.from({length: n}, (_, i) => <div key={i} style={{height: 12, width: i === n - 1 ? w * .6 : w, background: grey, borderRadius: 6, marginTop: i ? 9 : 0}}/>)}</>;

const Win: React.FC<{i: number; f: number; title: string; sub: string; children: (land: number) => React.ReactNode}> = ({i, f, title, sub, children}) => {
  const enter = E.toolWord[i] - 3, s = seg(f, enter, enter + 22, easeCam), land = seg(f, E.toolArrive[i], E.toolArrive[i] + 14, easeOut);
  return <div style={{position: 'absolute', left: XS[i], top: Y + (1 - s) * 44, width: W, height: H, opacity: ramp(f, enter, enter + 14), borderRadius: 22, overflow: 'hidden', background: '#f7faf8', boxShadow: '0 26px 60px #000a', color: ink}}>
    <div style={{height: 64, background: '#e8efeb', display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: '2px solid #d3ddd8'}}>
      {['#ff6b5e', '#ffc04d', '#4fd16a'].map((c) => <span key={c} style={{width: 13, height: 13, borderRadius: '50%', background: c}}/>)}
      <span style={{marginLeft: 8, fontSize: 25, fontWeight: 760}}>{title}</span><span style={{fontSize: 17, color: '#5a6f69', marginLeft: 'auto', whiteSpace: 'nowrap'}}>{sub}</span>
    </div>
    <div style={{padding: '22px 22px', position: 'relative', height: H - 64}}>{children(land)}</div>
  </div>;
};
const item = (land: number, f: number, at: number): React.CSSProperties => ({opacity: ramp(f, at, at + 5), transform: `translateY(${(1 - land) * 36}px)`, background: `rgb(255,${255 - 22 * (1 - ramp(f, at + 4, at + 26))},${255 - 90 * (1 - ramp(f, at + 4, at + 26))})`});

export const ToolsScene: React.FC<{f: number}> = ({f}) => {
  const A = E.toolArrive;
  return <>
    <Win i={0} f={f} title="Mattermost" sub="your team’s Slack">{(land) => <div>
      <div style={{fontSize: 26, fontWeight: 740, color: teal, marginBottom: 18}}># operations</div>
      {[0, 1].map((k) => <div key={k} style={{display: 'flex', gap: 14, marginBottom: 22}}><div style={{width: 48, height: 48, borderRadius: 10, background: ['#b9c6e8', '#e8c9b0'][k]}}/><div>{bars(2, 210)}</div></div>)}
      <div style={{display: 'flex', gap: 14, padding: 14, borderRadius: 14, ...item(land, f, A[0])}}><div style={{width: 48, height: 48, flex: 'none', borderRadius: 10, background: '#fff', display: 'grid', placeItems: 'center'}}><RealCup f={f} size={38}/></div><div><div style={{fontSize: 22, fontWeight: 740}}>Kaki</div><div style={{fontSize: 25, fontWeight: 650, marginTop: 4, lineHeight: 1.2}}>Catering needs two weeks’ notice before any supplier switch</div></div></div>
    </div>}</Win>
    <Win i={1} f={f} title="Gitea" sub="your team’s GitHub">{(land) => <div>
      <div style={{fontSize: 26, fontWeight: 740, color: teal, marginBottom: 14}}>Issues</div>
      <div style={{display: 'flex', gap: 16, marginBottom: 16, fontSize: 23, color: '#5a6f69'}}><span style={{fontWeight: 700, color: ink}}>Open</span><span>Closed</span></div>
      <div style={{display: 'flex', alignItems: 'center', gap: 14, padding: '16px 14px', borderRadius: 12, marginBottom: 12, ...item(land, f, A[1])}}><span style={{width: 22, height: 22, flex: 'none', borderRadius: '50%', border: `4px solid ${teal}`}}/><span style={{fontSize: 25, fontWeight: 650, lineHeight: 1.15}}>Compare two other packaging suppliers</span></div>
      {[0, 1].map((k) => <div key={k} style={{display: 'flex', alignItems: 'center', gap: 14, padding: '16px 14px', borderBottom: '2px solid #e5ece8'}}><span style={{width: 22, height: 22, flex: 'none', borderRadius: '50%', border: '4px solid #9fb0aa'}}/>{bars(1, 230)}</div>)}
    </div>}</Win>
    <Win i={2} f={f} title="Calendar" sub="next week">{(land) => <div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6, fontSize: 21, fontWeight: 700, color: '#5a6f69', textAlign: 'center'}}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((d) => <div key={d}>{d}</div>)}</div>
      <div style={{position: 'relative', height: 400, marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 6}}>
        {[0, 1, 2, 3, 4].map((c) => <div key={c} style={{background: '#eef3f0', borderRadius: 8}}/>)}
        <div style={{position: 'absolute', left: 4, top: 70, width: '42%', height: 160, borderRadius: 8, padding: 9, boxSizing: 'border-box', fontSize: 19, lineHeight: 1.15, fontWeight: 700, color: '#fff', background: teal, opacity: ramp(f, A[2], A[2] + 5), transform: `translateY(${(1 - land) * 30}px)`}}>Call with Jade Packaging</div>
      </div>
    </div>}</Win>
    <Win i={3} f={f} title="Wiki.js" sub="your team’s wiki">{(land) => <div>
      <div style={{fontSize: 24, fontWeight: 740, color: teal, marginBottom: 6}}>Meetings</div>
      <div style={{fontSize: 36, fontWeight: 780, letterSpacing: '-.025em', marginBottom: 20}}>Decisions</div>
      <div style={{display: 'flex', alignItems: 'center', gap: 14, padding: '16px 14px', borderRadius: 12, marginBottom: 12, ...item(land, f, A[3])}}><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke={teal} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{flex: 'none'}}><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h6"/></svg><span style={{fontSize: 25, fontWeight: 650, lineHeight: 1.15}}>Packaging contract: renegotiate</span></div>
      {[0, 1, 2].map((k) => <div key={k} style={{display: 'flex', alignItems: 'center', gap: 14, padding: '16px 14px', borderBottom: '2px solid #e5ece8'}}><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#9fb0aa" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" style={{flex: 'none'}}><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h6"/></svg>{bars(1, 220 - k * 24)}</div>)}
    </div>}</Win>
  </>;
};
