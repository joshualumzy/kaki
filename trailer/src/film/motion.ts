import {Easing, interpolate} from 'remotion';

export const easeCam = Easing.bezier(.45, 0, .2, 1);
export const easeOut = Easing.bezier(.2, .8, .2, 1);
export const easeIn = Easing.bezier(.5, 0, .8, .3);
export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** 0..1 progress between two frames with a chosen easing. */
export const seg = (f: number, from: number, to: number, easing: (t: number) => number = easeCam) => easing(clamp01((f - from) / Math.max(1, to - from)));
/** Damped landing, at most ~4% overshoot, one rebound. 0 before t=0, ~1 after about 20 f. */
export const settle = (t: number) => t <= 0 ? 0 : 1 - Math.exp(-t / 5) * Math.cos(t * .55);
/** Piecewise value through keyframes [frame, value], eased between each pair, held at both ends. */
export const track = (f: number, keys: [number, number][], easing: (t: number) => number = easeCam): number => {
  if (f <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (f <= keys[i][0]) return mix(keys[i - 1][1], keys[i][1], easing(clamp01((f - keys[i - 1][0]) / Math.max(1, keys[i][0] - keys[i - 1][0]))));
  return keys[keys.length - 1][1];
};
/** Camera keyframes [frame, cx, cy, scale]. */
export type CamKey = [number, number, number, number];
export const camAt = (f: number, keys: CamKey[]) => ({
  cx: track(f, keys.map((k) => [k[0], k[1]])), cy: track(f, keys.map((k) => [k[0], k[2]])), s: track(f, keys.map((k) => [k[0], k[3]])),
});
/** A quadratic Bezier point. */
export const quad = (p0: [number, number], p1: [number, number], p2: [number, number], t: number): [number, number] => [
  (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];
export const cubic = (p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], t: number): [number, number] => {
  const u = 1 - t; return [u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0], u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1]];
};
export const ramp = (f: number, from: number, to: number) => interpolate(f, [from, to], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic)});
