/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoomEvent } from 'livekit-client';

const room = vi.hoisted(() => ({
  canPlaybackAudio: false,
  handlers: new Map<string, Set<(...args: unknown[]) => void>>(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = room.handlers.get(event) ?? new Set();
    handlers.add(handler);
    room.handlers.set(event, handlers);
  }),
  off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    room.handlers.get(event)?.delete(handler);
  }),
  startAudio: vi.fn(async () => {
    room.canPlaybackAudio = true;
    for (const handler of room.handlers.get(RoomEvent.AudioPlaybackStatusChanged) ?? []) handler();
  }),
}));

vi.mock('@livekit/components-react', () => ({ useRoomContext: () => room }));

import { AudioUnlockPrompt } from './AudioUnlock';

afterEach(() => {
  cleanup();
  room.canPlaybackAudio = false;
  room.handlers.clear();
  room.on.mockClear();
  room.off.mockClear();
  room.startAudio.mockClear();
});

describe('AudioUnlockPrompt', () => {
  it('stays out of the way when the browser already allows sound', () => {
    room.canPlaybackAudio = true;
    render(<AudioUnlockPrompt />);
    expect(screen.queryByRole('button', { name: /turn on sound/i })).toBeNull();
  });

  it('offers an explicit tap when playback is blocked, then disappears once sound starts', async () => {
    render(<AudioUnlockPrompt />);

    const button = await screen.findByRole('button', { name: 'Tap to turn on sound' });
    fireEvent.click(button);

    await waitFor(() => expect(room.startAudio).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /turn on sound/i })).toBeNull());
  });

  it('says why the sound is still blocked instead of failing silently', async () => {
    room.startAudio.mockRejectedValueOnce(new Error('Playback is still blocked.'));
    render(<AudioUnlockPrompt />);

    fireEvent.click(await screen.findByRole('button', { name: 'Tap to turn on sound' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Playback is still blocked.');
  });
});
