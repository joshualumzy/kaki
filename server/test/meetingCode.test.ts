import { describe, expect, it, vi } from 'vitest';
import { createMeetingCodeSource } from '../src/meetingCode';

describe('meeting code source', () => {
  it('makes a six-character unambiguous code without Math.random', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('meeting codes must not use Math.random');
    });
    try {
      const source = createMeetingCodeSource('');
      expect(source.value).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      source.rotate();
      expect(source.value).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    } finally {
      random.mockRestore();
    }
  });
});
