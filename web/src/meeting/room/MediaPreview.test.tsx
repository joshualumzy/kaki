/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaPreview } from './MediaPreview';

afterEach(cleanup);

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
});
