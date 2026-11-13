/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeBar } from './TypeBar';

afterEach(cleanup);

function setup() {
  const send = vi.fn();
  render(<TypeBar send={send} />);
  return { send, input: screen.getByLabelText('Type to the meeting') as HTMLInputElement };
}

describe('TypeBar', () => {
  it('enables the lock button only after the server reports a visitor line on this topic', () => {
    const send = vi.fn();
    const view = render(<TypeBar send={send} canLock={false} />);
    const button = screen.getByRole('button', { name: 'Lock in my decision' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    view.rerender(<TypeBar send={send} canLock />);
    fireEvent.click(button);
    expect(send).toHaveBeenCalledWith({ kind: 'lock' });
  });
  it('sends what is typed on Enter, trimmed, and clears the box', () => {
    const { send, input } = setup();
    fireEvent.change(input, { target: { value: '  What is the status?  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(send).toHaveBeenCalledWith({ kind: 'text', text: 'What is the status?' });
    expect(input.value).toBe('');
  });

  it('sends nothing for an empty message, and Send is disabled', () => {
    const { send, input } = setup();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form')!);
    expect(send).not.toHaveBeenCalled();
    expect((screen.getByText('Send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('tells the server that keys are being pressed, but not on every key', () => {
    vi.useFakeTimers();
    const { send, input } = setup();
    for (let key = 0; key < 5; key += 1) fireEvent.keyDown(input, { key: 'a' });
    expect(send.mock.calls.filter(([message]) => message.kind === 'typing')).toHaveLength(1);
    vi.advanceTimersByTime(500);
    fireEvent.keyDown(input, { key: 'b' });
    expect(send.mock.calls.filter(([message]) => message.kind === 'typing')).toHaveLength(2);
    vi.useRealTimers();
  });

  it('pauses the AI attendees from the button or Spacebar, and plays when clicked or Spacebar pressed again', () => {
    const { send } = setup();
    fireEvent.click(screen.getByText(/Pause/));
    expect(send).toHaveBeenLastCalledWith({ kind: 'stop' });
    fireEvent.click(screen.getByText(/Play/));
    expect(send).toHaveBeenLastCalledWith({ kind: 'resume' });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(send).toHaveBeenLastCalledWith({ kind: 'stop' });
    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(send).toHaveBeenLastCalledWith({ kind: 'resume' });
  });
});
