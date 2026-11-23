/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaPreview } from './MediaPreview';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

function renderPreview(typingHint?: string): void {
  render(
    <MediaPreview
      value={{ microphone: false, camera: false }}
      onChange={() => undefined}
      onProblem={() => undefined}
      {...(typingHint === undefined ? {} : { typingHint })}
    />,
  );
}

describe('MediaPreview', () => {
  it('uses neutral typing copy when the caller does not name an audience', () => {
    renderPreview();
    expect(screen.getByText('Microphone off: you will type your lines')).toBeTruthy();
    expect(screen.queryByText(/AI attendees/)).toBeNull();
  });

  it('keeps the practice hint when the practice form asks for it', () => {
    renderPreview('Microphone off: you will type to the AI attendees');
    expect(screen.getByText('Microphone off: you will type to the AI attendees')).toBeTruthy();
  });

  it('tells a person how to allow a blocked microphone, or join to type', async () => {
    const onProblem = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('denied', 'NotAllowedError');
        }),
      },
    });
    render(
      <MediaPreview
        value={{ microphone: true, camera: false }}
        onChange={() => undefined}
        onProblem={onProblem}
      />,
    );

    await waitFor(() =>
      expect(onProblem).toHaveBeenCalledWith(
        "Your microphone is blocked. Allow it in your browser's site settings, or join to type instead.",
      ),
    );
  });

  it('tells a person how to allow a blocked camera', async () => {
    const onProblem = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          throw new DOMException('denied', 'NotAllowedError');
        }),
      },
    });
    render(
      <MediaPreview
        value={{ microphone: false, camera: true }}
        onChange={() => undefined}
        onProblem={onProblem}
      />,
    );

    await waitFor(() =>
      expect(onProblem).toHaveBeenCalledWith(
        "Your camera is blocked. Allow it in your browser's site settings to use it.",
      ),
    );
  });
});
