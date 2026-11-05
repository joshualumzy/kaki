/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartPrompt } from './StartPrompt';

afterEach(cleanup);

describe('StartPrompt', () => {
  it('tells the person to read their briefing and waits for the button', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    expect(screen.getByText(/Read your briefing first/)).toBeTruthy();
    expect(screen.getByText(/stay quiet until you start/)).toBeTruthy();
    expect(onStart).not.toHaveBeenCalled();
  });

  it('starts the meeting when the button is pressed', () => {
    const onStart = vi.fn();
    render(<StartPrompt onStart={onStart} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start the meeting' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
