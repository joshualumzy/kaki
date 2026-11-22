import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/npc/wav';

describe('encodeWav', () => {
  it('writes a mono 16-bit PCM header followed by the samples', () => {
    const wav = encodeWav(Int16Array.from([1, -2, 3]), 16000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(40)).toBe(6);
    expect(wav.length).toBe(44 + 6);
    expect(wav.readInt16LE(46)).toBe(-2);
  });
});
