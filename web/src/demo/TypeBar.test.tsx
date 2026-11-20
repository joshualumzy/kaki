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

  it('shows the server record as its state, with a brief pending state while it confirms', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    const view = render(<TypeBar send={send} paused={false} onPauseChange={onPauseChange} />);

    fireEvent.click(screen.getByText(/⏸ Pause/));
    expect(send).toHaveBeenLastCalledWith({ kind: 'stop' });
    expect(onPauseChange).toHaveBeenLastCalledWith(true);
    const pending = screen.getByText(/Pausing/);
    expect((pending as HTMLButtonElement).disabled).toBe(true);

    // The record, not the click, is what changes the button.
    view.rerender(<TypeBar send={send} paused onPauseChange={onPauseChange} />);
    expect(screen.getByText(/▶ Play/)).toBeTruthy();

    fireEvent.click(screen.getByText(/▶ Play/));
    expect(send).toHaveBeenLastCalledWith({ kind: 'resume' });
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(/Resuming/)).toBeTruthy();

    view.rerender(<TypeBar send={send} paused={false} onPauseChange={onPauseChange} />);
    expect(screen.getByText(/⏸ Pause/)).toBeTruthy();

    fireEvent.keyDown(window, { key: ' ', code: 'Space' });
    expect(send).toHaveBeenLastCalledWith({ kind: 'stop' });
    expect(onPauseChange).toHaveBeenLastCalledWith(true);
  });

  it('reverts with a notice when the pause command never leaves the browser', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => false);
    render(<TypeBar send={send} paused={false} onPauseChange={onPauseChange} />);

    fireEvent.click(screen.getByText(/⏸ Pause/));
    expect(screen.getByRole('alert').textContent).toBe("Couldn't pause, try again");
    expect(screen.getByText(/⏸ Pause/)).toBeTruthy();
  });

  it('reverts with a notice when the server refuses the pause, ignoring an older refusal', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    const stale = { commandType: 'SET_PAUSED', reason: 'an older meeting refused this' };
    const view = render(
      <TypeBar send={send} paused={false} onPauseChange={onPauseChange} pauseRejection={stale} />,
    );

    fireEvent.click(screen.getByText(/⏸ Pause/));
    expect(screen.queryByRole('alert')).toBeNull();

    view.rerender(
      <TypeBar
        send={send}
        paused={false}
        onPauseChange={onPauseChange}
        pauseRejection={{ commandType: 'SET_PAUSED', reason: 'Only a person seated in this meeting can pause it' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe("Couldn't pause, try again");
    expect(screen.getByText(/⏸ Pause/)).toBeTruthy();
  });

  it('asks the server to resume before sending a typed line while the record says paused', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    render(<TypeBar send={send} paused onPauseChange={onPauseChange} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Carry on' } });
    fireEvent.submit(input.closest('form')!);
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
    expect(send).toHaveBeenCalledWith({ kind: 'text', text: 'Carry on' });
    expect(screen.getByText(/Resuming/)).toBeTruthy();
  });

  it('asks the server to resume when a starter line takes the person\'s turn', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    render(<TypeBar send={send} paused onPauseChange={onPauseChange} />);

    fireEvent(window, new Event('kaki:quick-line'));
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
  });

  it('does not ask the server to resume a meeting that is already running', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    render(<TypeBar send={send} paused={false} onPauseChange={onPauseChange} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Carry on' } });
    fireEvent.submit(input.closest('form')!);
    expect(onPauseChange).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({ kind: 'text', text: 'Carry on' });
  });
});
