/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecognizerHandlers } from './speech';

const speechMock = vi.hoisted(() => {
  const calls: Array<{ handlers: RecognizerHandlers; options: unknown }> = [];
  const room = { localParticipant: { publishData: async () => undefined } };
  return {
    calls,
    room,
    startRecognizer: (
      _recognition: unknown,
      handlers: RecognizerHandlers,
      options: unknown,
    ): (() => void) => {
      calls.push({ handlers, options });
      return () => undefined;
    },
  };
});

vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => speechMock.room,
  useLocalParticipant: () => ({ isMicrophoneEnabled: true }),
}));

vi.mock('./speech', () => ({
  browserRecognitionWanted: () => true,
  speechRecognitionCtor: () => class {},
  startRecognizer: speechMock.startRecognizer,
  RECOGNITION_EXHAUSTED_MESSAGE:
    'Speech recognition kept failing and has stopped. Check your connection, then try again.',
}));

import { LocalSpeechSTT } from './LocalSpeechSTT';

afterEach(() => {
  cleanup();
  speechMock.calls.length = 0;
});

describe('LocalSpeechSTT', () => {
  it('offers a retry when recognition gives up after repeated failures', () => {
    render(<LocalSpeechSTT />);
    expect(speechMock.calls).toHaveLength(1);

    act(() => {
      speechMock.calls[0]?.handlers.onExhausted?.(
        'Speech recognition kept failing and has stopped. Check your connection, then try again.',
      );
    });

    expect(
      screen.getByText(
        'Speech recognition kept failing and has stopped. Check your connection, then try again.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(speechMock.calls).toHaveLength(2);
  });

  it('does not offer a retry for a permission failure', () => {
    render(<LocalSpeechSTT />);

    act(() => {
      speechMock.calls[0]?.handlers.onFatal?.('Microphone access was blocked for speech recognition.');
    });

    expect(screen.getByText('Microphone access was blocked for speech recognition.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
