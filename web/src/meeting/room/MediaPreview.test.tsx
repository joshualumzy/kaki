/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAMERA_BLOCKED_PROBLEM, MIC_BLOCKED_PROBLEM } from '../../net/plainFailure';
import { MediaPreview } from './MediaPreview';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

function renderPreview(): void {
  render(
    <MediaPreview
      value={{ microphone: false, camera: false }}
      onChange={() => undefined}
      onProblem={() => undefined}
    />,
  );
}

describe('MediaPreview', () => {
  it('tells a person with the microphone off to turn it on, with no typing', () => {
    renderPreview();
    expect(screen.getByText('Microphone off: turn it on to speak')).toBeTruthy();
    expect(screen.queryByText(/\btype\b/i)).toBeNull();
  });

  it('tells a person how to allow a blocked microphone', async () => {
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
      expect(onProblem).toHaveBeenCalledWith(MIC_BLOCKED_PROBLEM),
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
      expect(onProblem).toHaveBeenCalledWith(CAMERA_BLOCKED_PROBLEM),
    );
  });
});
