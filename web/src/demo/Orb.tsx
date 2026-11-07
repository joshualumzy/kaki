import { useEffect, useRef } from 'react';

export type OrbState = 'idle' | 'thinking' | 'speaking';

/** The four orb colour pairs, as CSS variables from ui/tokens.css. */
const PALETTE: readonly (readonly [string, string])[] = [
  ['--orb-b', '--orb-d'],
  ['--orb-a', '--orb-c'],
  ['--orb-d', '--orb-b'],
  ['--orb-c', '--orb-a'],
  ['--orb-e', '--orb-a'],
];

/** The colour pair for the n-th attendee, so each person keeps their own orb. */
export function orbPalette(index: number): readonly [string, string] {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? PALETTE[0]!;
}

export interface OrbProps {
  state: OrbState;
  /** 0 to 1: how loud the person is right now. Overrides the default pulse while speaking. */
  level?: number;
  palette?: readonly [string, string];
  className?: string;
}

function cssColour(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#00c2a8';
}

/**
 * A living blob that shows who is talking: it breathes when idle, spins an arc when thinking
 * and ripples with the voice when speaking.
 */
export function Orb({ state, level, palette = PALETTE[1]!, className }: OrbProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, level });
  live.current = { state, level };
  const reduce = useRef(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const element = canvas.current;
    if (element === null || typeof requestAnimationFrame !== 'function') return undefined;
    const context = element.getContext('2d');
    if (context === null) return undefined;
    let frameId = 0;
    let amp = 0.05;
    let time = 0;
    let previous = performance.now();
    let frames = 0;
    let colours = [cssColour(palette[0]), cssColour(palette[1])] as const;
    const seed = Math.random() * 100;

    const render = (now: number): void => {
      frameId = requestAnimationFrame(render);
      const dt = Math.min(0.05, (now - previous) / 1000);
      previous = now;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || document.hidden) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.round(box.width * ratio);
      const height = Math.round(box.height * ratio);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
      }
      frames += 1;
      if (frames % 40 === 0) colours = [cssColour(palette[0]), cssColour(palette[1])];

      const { state: current, level: loud } = live.current;
      let target = 0.05;
      if (current === 'thinking') target = 0.12;
      if (current === 'speaking') target = loud === undefined ? 0.3 + 0.12 * Math.sin(time * 9) + 0.08 * Math.sin(time * 23) : 0.1 + loud * 0.5;
      amp += (target - amp) * Math.min(1, dt * 9);
      time += dt * (current === 'thinking' ? 1.8 : 1) * (reduce.current ? 0.3 : 1);

      const cx = width / 2;
      const cy = height / 2;
      const base = Math.min(width, height) * 0.24;
      context.clearRect(0, 0, width, height);
      if (current === 'speaking') {
        for (let k = 0; k < 3; k += 1) {
          const phase = (time * 0.7 + k / 3) % 1;
          context.beginPath();
          context.arc(cx, cy, base * (1.15 + phase * 0.9), 0, Math.PI * 2);
          context.strokeStyle = colours[0];
          context.globalAlpha = (1 - phase) * 0.28;
          context.lineWidth = 2 * (width / 400 + 0.6);
          context.stroke();
        }
      }
      context.globalAlpha = 1;
      const points = 72;
      context.beginPath();
      for (let i = 0; i < points; i += 1) {
        const angle = (i / points) * Math.PI * 2;
        const noise =
          Math.sin(angle * 3 + time * 1.6 + seed) * 0.5 + Math.sin(angle * 5 - time * 1.1 + seed * 2) * 0.35 + Math.sin(angle * 2 + time * 0.7) * 0.3;
        const radius = base * (1 + amp * noise * 1.25 + amp * 0.35);
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      const fill = context.createRadialGradient(cx - base * 0.35, cy - base * 0.4, base * 0.1, cx, cy, base * 1.4);
      fill.addColorStop(0, '#ffffff');
      fill.addColorStop(0.22, colours[1]);
      fill.addColorStop(1, colours[0]);
      context.shadowColor = colours[0];
      context.shadowBlur = base * (current === 'speaking' ? 0.9 : 0.5);
      context.fillStyle = fill;
      context.fill();
      context.shadowBlur = 0;
      if (current === 'thinking') {
        context.beginPath();
        context.arc(cx, cy, base * 1.35, time * 3, time * 3 + 1.6);
        context.strokeStyle = colours[0];
        context.lineWidth = 3 * (width / 400 + 0.6);
        context.lineCap = 'round';
        context.stroke();
      }
    };
    frameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameId);
  }, [palette]);

  return <canvas ref={canvas} className={className} aria-hidden="true" />;
}
