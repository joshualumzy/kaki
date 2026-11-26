import {spring} from 'remotion';

export const C = {ink: '#0d1117', teal: '#0b6b5c', mint: '#00c2a8', orange: '#ff5a1f', violet: '#4652e6', pearl: '#e9ecf2'};
export const punch = (f: number, from: number, damping = 13) => spring({frame: Math.max(0, f - from), fps: 30, config: {mass: .7, stiffness: 245, damping}});
