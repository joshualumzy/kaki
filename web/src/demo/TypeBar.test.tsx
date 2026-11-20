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

  it('tells the server directly about a pause and resume, beside the instant LiveKit gate', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn();
    render(<TypeBar send={send} onPauseChange={onPauseChange} />);

    fireEvent.click(screen.getByText(/Pause/));
    expect(send).toHaveBeenLastCalledWith({ kind: 'stop' });
    expect(onPauseChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByText(/Play/));
    expect(send).toHaveBeenLastCalledWith({ kind: 'resume' });
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
  });

  it('resumes the server when a typed message or starter line takes the person\'s turn', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn();
    render(<TypeBar send={send} onPauseChange={onPauseChange} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.click(screen.getByText(/Pause/));
    fireEvent.change(input, { target: { value: 'Carry on' } });
    fireEvent.submit(input.closest('form')!);
    expect(onPauseChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByText(/Pause/));
    fireEvent(window, new Event('kaki:quick-line'));
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
  });
});
