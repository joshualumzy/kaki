import { describe, expect, it } from 'vitest';
import { meetingApiPath } from './meetingScope';

describe('meetingApiPath', () => {
  it('moves one meeting route under its own id', () => {
    expect(meetingApiPath('mtg-1', '/api/livekit/token')).toBe(
      '/api/meetings/mtg-1/livekit/token',
    );
    expect(meetingApiPath('mtg-1', '/api/meeting/state')).toBe(
      '/api/meetings/mtg-1/meeting/state',
    );
    expect(meetingApiPath('a/b', '/api/scenario')).toBe('/api/meetings/a%2Fb/scenario');
  });
});
