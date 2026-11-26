import data from './timeline.json';

export type Line = {id: string; voice: 'narrator' | 'mei' | 'raj' | 'aisha'; speaker: string; text: string; startFrame: number; endFrame: number; sourceSeconds: number; playbackRate: number; start: number; end: number; durFrames: number; amp: string};
export const FPS = data.fps;
export const WIDTH = data.width;
export const HEIGHT = data.height;
export const DURATION_FRAMES = data.durationFrames;
export const lines = data.lines as Line[];
export const events = data.events;
export const sfxFrames = data.sfxFrames as Record<string, number>;
export const line = (id: string): Line => {const found = lines.find((l) => l.id === id); if (!found) throw new Error(`Missing line ${id}`); return found;};
export const lineAt = (frame: number): Line | undefined => lines.find((l) => frame >= l.startFrame && frame < l.endFrame);
/** Voice amplitude (0..1) of a character line at a frame; 0 outside the line. */
export const ampAt = (frame: number, voice: Line['voice']): number => {
  const l = lines.find((x) => x.voice === voice && frame >= x.startFrame && frame < x.endFrame);
  return l ? Number(l.amp[frame - l.startFrame] ?? 0) / 9 : 0;
};
export const beat = (n: number) => Math.round(n * 15.65);
