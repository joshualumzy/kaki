// Deterministic, synthesized, soft sound effects (no downloads). Run from trailer: node src/film/make-sfx.mjs
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const out = resolve(dirname(fileURLToPath(import.meta.url)), 'sfx');
mkdirSync(out, {recursive: true});
const SR = 44100;
let seed = 20261126;
const rnd = () => {seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1;};
const TAU = Math.PI * 2;
const lowpass = (x, hz) => {const a = 1 - Math.exp(-TAU * hz / SR); let y = 0; return x.map((v) => (y += a * (v - y)));};
const highpass = (x, hz) => {const lp = lowpass(x, hz); return x.map((v, i) => v - lp[i]);};
const band = (x, lo, hi) => lowpass(highpass(x, lo), hi);
const make = (seconds, fn) => Float64Array.from({length: Math.round(seconds * SR)}, (_, i) => fn(i / SR, i / SR / seconds));
const noise = (seconds) => make(seconds, () => rnd());
const env = (t, attack, decay) => (1 - Math.exp(-t / attack)) * Math.exp(-t / decay);
const dbPeak = (db) => Math.min(0.125, Math.pow(10, (db + 6) / 20)); // spec level +6 dB for audibility, hard cap -18 dBFS
const save = (name, samples, db) => {
  const soft = lowpass(Float64Array.from(samples), 8000);
  const n = soft.length, fade = Math.round(0.004 * SR);
  let max = 1e-9; for (const v of soft) max = Math.max(max, Math.abs(v));
  const peak = db > 0 ? db : dbPeak(db);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(1, i / fade, (n - 1 - i) / fade);
    buf.writeInt16LE(Math.round(soft[i] / max * peak * edge * 32767), 44 + i * 2);
  }
  writeFileSync(resolve(out, `${name}.wav`), buf);
};

// Soft paper rip: 120 ms band-limited noise, exponential decay. Four pitch variants.
const rip = (k) => {
  const f = [1, 1.09, .92, 1.05][k];
  const n = band(noise(0.16), 2000 * f, 5000 * f);
  return make(0.16, (t) => n[Math.round(t * SR)] * env(t, 0.006, 0.045));
};
[0, 1, 2, 3].forEach((k) => save(`rip${k}`, rip(k), -24));
// Rewind flutter: the rips played backwards, overlapping.
{
  const total = make(0.7, () => 0);
  [0, 1, 2, 3].forEach((k) => {const r = Array.from(rip(k)).reverse(); r.forEach((v, i) => {const j = i + Math.round(k * 0.12 * SR); if (j < total.length) total[j] += v;});});
  save('flutter', total, -30);
}
// Sticky slap: low-passed thump.
{const n = lowpass(noise(0.06), 900); save('sticky', make(0.06, (t) => n[Math.round(t * SR)] * Math.exp(-t / 0.012) + Math.sin(TAU * 140 * t) * Math.exp(-t / 0.015)), -32);}
// Envelope slide: soft paper friction.
{const n = band(noise(0.32), 1200, 3500); save('slide', make(0.32, (t, p) => n[Math.round(t * SR)] * Math.sin(Math.PI * p) ** 1.5 * (0.7 + 0.3 * Math.sin(TAU * 17 * t))), -30);}
// Soft landing thud.
{const n = lowpass(noise(0.1), 600); save('thud', make(0.16, (t) => Math.sin(TAU * 80 * t) * env(t, 0.004, 0.035) + n[Math.round(t * SR)] * 0.35 * Math.exp(-t / 0.01)), -22);}
// Flap open: a lighter paper tick.
{const n = band(noise(0.08), 2500, 6000); save('flap', make(0.08, (t) => n[Math.round(t * SR)] * env(t, 0.004, 0.02)), -30);}
// Phone buzz: two soft 80 ms bursts at 180 Hz.
save('buzz', make(0.34, (t) => {const a = t < 0.08 ? env(t, 0.01, 1) * (1 - env(Math.max(0, t - 0.06), 0.01, 1)) : 0; const b = t >= 0.17 && t < 0.25 ? env(t - 0.17, 0.01, 1) * (1 - env(Math.max(0, t - 0.23), 0.01, 1)) : 0; return Math.sin(TAU * 180 * t) * (a + b) + Math.sin(TAU * 360 * t) * 0.2 * (a + b);}), -20);
// Mug set-down: low-passed click.
{const n = lowpass(noise(0.1), 1200); save('mug', make(0.1, (t) => n[Math.round(t * SR)] * Math.exp(-t / 0.014) + Math.sin(TAU * 420 * t) * Math.exp(-t / 0.02) * 0.4), -26);}
// Lid hinge creak.
{const n = band(noise(0.3), 900, 1600); save('creak', make(0.3, (t, p) => n[Math.round(t * SR)] * Math.sin(Math.PI * p) * (0.6 + 0.4 * Math.sin(TAU * 23 * t))), -30);}
// Call join chime: two soft sines.
save('join', make(0.4, (t) => Math.sin(TAU * 660 * t) * env(t, 0.01, 0.07) + (t > 0.12 ? Math.sin(TAU * 880 * (t - 0.12)) * env(t - 0.12, 0.01, 0.09) : 0)), -24);
// Cup settle: pitched wood tok.
save('tok', make(0.1, (t) => Math.sin(TAU * 2200 * t) * env(t, 0.002, 0.012)), -28);
// Cup glow glint.
save('glint', make(0.32, (t, p) => Math.sin(TAU * (1200 * t + 200 * t * p)) * Math.sin(Math.PI * Math.min(1, p * 1.2)) ** 2), -30);
// Pen tap.
{const n = highpass(noise(0.07), 1800); save('pen', make(0.07, (t) => (n[Math.round(t * SR)] * 0.4 + Math.sin(TAU * 2000 * t)) * Math.exp(-t / 0.008)), -30);}
// Paper crease: two soft ticks.
{const n = band(noise(0.16), 1800, 5000); save('crease', make(0.16, (t) => n[Math.round(t * SR)] * (env(t, 0.002, 0.012) + (t > 0.08 ? env(t - 0.08, 0.002, 0.012) : 0))), -30);}
// Whoosh variants (each a semitone up).
[0, 1, 2, 3].forEach((k) => {
  const f = Math.pow(2, k / 12), n = lowpass(noise(0.38), 2000 * f);
  save(`whoosh${k}`, make(0.38, (t, p) => n[Math.round(t * SR)] * Math.sin(Math.PI * Math.pow(p, 0.75)) ** 2), k === 0 ? -24 : -30);
});
// Sent: marimba-like sine pair.
save('sent', make(0.7, (t) => Math.sin(TAU * 523.25 * t) * env(t, 0.003, 0.22) + (t > 0.09 ? Math.sin(TAU * 783.99 * (t - 0.09)) * env(t - 0.09, 0.003, 0.3) : 0)), -26);
// Row settle tick.
{const n = lowpass(noise(0.08), 1500); save('settle', make(0.08, (t) => n[Math.round(t * SR)] * Math.exp(-t / 0.012) + Math.sin(TAU * 300 * t) * Math.exp(-t / 0.02) * 0.5), -28);}
// Tap click for buttons.
{const n = highpass(noise(0.08), 1500); save('click', make(0.08, (t) => n[Math.round(t * SR)] * 0.4 * Math.exp(-t / 0.006) + Math.sin(TAU * 1900 * t) * Math.exp(-t / 0.012) * 0.6), -28);}
// Kitchen murmur (very low) and room tone loop (pink-ish noise low-passed at 400 Hz).
{const n = lowpass(noise(1.6), 600); save('murmur', make(1.6, (t, p) => n[Math.round(t * SR)] * Math.sin(Math.PI * p) * (0.6 + 0.4 * Math.sin(TAU * 3 * t))), -40);}
{
  const secs = 12, n = lowpass(noise(secs + 1), 400), x = (s) => n[Math.round(s * SR)];
  // seamless loop: blend the last second into the one before the start
  save('roomtone', make(secs, (t) => {const fade = Math.max(0, (t - (secs - 1)));  return fade > 0 ? x(t) * (1 - fade) + x(t - secs + 1 + secs) * 0 + x(t + 1) * fade : x(t);}), -38);
}

// ---- human-sound PLACEHOLDERS: swap sfx/mei-sigh.wav and sfx/raj-groan.wav for real recordings (same names, any length up to ~1.5 s).
{const n = band(noise(1.3), 500, 3200); save('mei-sigh', make(1.3, (t, p) => n[Math.round(t * SR)] * (Math.sin(Math.PI * Math.min(1, p * 1.25)) ** 2) * Math.exp(-p * 1.4) * (0.8 + 0.2 * Math.sin(TAU * 5 * t))), -22);}
{const n = lowpass(noise(0.9), 900); let ph = 0; save('raj-groan', make(0.9, (t, p) => {ph += TAU * (125 - 35 * p) / SR; const v = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) * 0.6 + n[Math.round(t * SR)] * 0.3; return v * Math.sin(Math.PI * Math.pow(p, 0.7)) ** 1.5;}), -22);}
// Typing: soft key clicks, about 1.7 s.
{
  const dur = 1.7, out = make(dur, () => 0); let t = 0.02;
  while (t < dur - 0.06) {const i0 = Math.round(t * SR), n = highpass(noise(0.03), 1500); for (let i = 0; i < n.length && i0 + i < out.length; i++) out[i0 + i] += n[i] * Math.exp(-i / SR / 0.005) * (0.6 + 0.4 * rnd()); t += 0.05 + 0.06 * Math.abs(rnd());}
  save('typing', out, -28);
}
// Soft card arrival and tile-off ticks.
save('card', make(0.2, (t) => Math.sin(TAU * (330 + 500 * (1 - Math.exp(-t * 30))) * t) * env(t, 0.006, 0.05)), -30);
{const n = lowpass(noise(0.12), 700); save('off', make(0.12, (t) => n[Math.round(t * SR)] * Math.exp(-t / 0.03) * 0.7 + Math.sin(TAU * 160 * t) * Math.exp(-t / 0.04)), -28);}
// Breath puff (comic exhale cloud) accompaniment: very light air.
{const n = band(noise(0.5), 900, 4000); save('puff', make(0.5, (t, p) => n[Math.round(t * SR)] * Math.sin(Math.PI * p) ** 2), -34);}
console.log('sfx written to', out);
