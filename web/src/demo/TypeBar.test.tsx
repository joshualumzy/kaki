/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('asks the server to resume and sends the typed line only once the record confirms it', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    const view = render(<TypeBar send={send} paused onPauseChange={onPauseChange} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Carry on' } });
    fireEvent.submit(input.closest('form')!);
    expect(onPauseChange).toHaveBeenLastCalledWith(false);
    // The line is not sent while the server still says paused, and it stays in the box.
    expect(send).not.toHaveBeenCalledWith({ kind: 'text', text: 'Carry on' });
    expect(input.value).toBe('Carry on');
    expect(screen.getByText(/Resuming/)).toBeTruthy();

    view.rerender(<TypeBar send={send} paused={false} onPauseChange={onPauseChange} />);
    expect(send).toHaveBeenCalledWith({ kind: 'text', text: 'Carry on' });
    expect(input.value).toBe('');
  });

  it('keeps the typed line when the resume request never leaves the browser', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => false);
    render(<TypeBar send={send} paused onPauseChange={onPauseChange} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Carry on' } });
    fireEvent.submit(input.closest('form')!);
    expect(send).not.toHaveBeenCalled();
    expect(input.value).toBe('Carry on');
    expect(screen.getByRole('alert').textContent).toBe("Couldn't resume, your message wasn't sent");
  });

  it('keeps the typed line when the server refuses the resume', () => {
    const send = vi.fn();
    const onPauseChange = vi.fn(() => true);
    const view = render(<TypeBar send={send} paused onPauseChange={onPauseChange} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'Carry on' } });
    fireEvent.submit(input.closest('form')!);
    expect(send).not.toHaveBeenCalledWith({ kind: 'text', text: 'Carry on' });

    view.rerender(
      <TypeBar
        send={send}
        paused
        onPauseChange={onPauseChange}
        pauseRejection={{ commandType: 'SET_PAUSED', reason: 'Only a person seated in this meeting can resume it' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe("Couldn't resume, your message wasn't sent");
    expect(send).not.toHaveBeenCalledWith({ kind: 'text', text: 'Carry on' });
    expect(input.value).toBe('Carry on');
  });

  it('clears a false pause failure notice when a later record matches the request', () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const onPauseChange = vi.fn(() => true);
      const view = render(<TypeBar send={send} paused={false} onPauseChange={onPauseChange} />);

      fireEvent.click(screen.getByText(/⏸ Pause/));
      act(() => vi.advanceTimersByTime(5_000));
      expect(screen.getByRole('alert').textContent).toBe("Couldn't pause, try again");

      // The record was only slow: it clears the false failure when it finally arrives.
      view.rerender(<TypeBar send={send} paused onPauseChange={onPauseChange} />);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps the line and says so when delivery fails', async () => {
    const send = vi.fn(async () => false);
    const onTextSent = vi.fn();
    render(<TypeBar send={send} onTextSent={onTextSent} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'The stock count is in.' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe("Couldn't send your line, try again"),
    );
    expect(input.value).toBe('The stock count is in.');
    expect(onTextSent).not.toHaveBeenCalled();
  });

  it('keeps the line when delivery throws', async () => {
    const send = vi.fn(() => Promise.reject(new Error('offline')));
    const onTextSent = vi.fn();
    render(<TypeBar send={send} onTextSent={onTextSent} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'The stock count is in.' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe("Couldn't send your line, try again"),
    );
    expect(input.value).toBe('The stock count is in.');
    expect(onTextSent).not.toHaveBeenCalled();
  });

  it('clears the line only once delivery is confirmed', async () => {
    let confirm: (delivered: boolean) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = resolve;
        }),
    );
    const onTextSent = vi.fn();
    render(<TypeBar send={send} onTextSent={onTextSent} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'The stock count is in.' } });
    fireEvent.submit(input.closest('form')!);

    expect(send).toHaveBeenCalledWith({ kind: 'text', text: 'The stock count is in.' });
    expect(input.value).toBe('The stock count is in.');
    expect(onTextSent).not.toHaveBeenCalled();

    await act(async () => {
      confirm(true);
      await Promise.resolve();
    });

    expect(input.value).toBe('');
    expect(onTextSent).toHaveBeenCalledWith('The stock count is in.');
  });

  it('reports the finalized typed line to the server path', () => {
    const send = vi.fn();
    const onTextSent = vi.fn();
    render(<TypeBar send={send} onTextSent={onTextSent} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '  What is the status?  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(onTextSent).toHaveBeenCalledWith('What is the status?');
  });

  it('shows why the server refused a human line', () => {
    render(
      <TypeBar
        send={vi.fn()}
        lineRejection={{ commandType: 'HUMAN_LINE', reason: 'The meeting is not running' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      "Couldn't add your line: The meeting is not running",
    );
  });

  it('puts a refused line back in the box so the person can send it again', () => {
    const send = vi.fn();
    const view = render(<TypeBar send={send} />);
    const input = screen.getByLabelText('Type to the meeting') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '  The stock count is in.  ' } });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('');

    // A server refusal carries no words back; the box still remembers what this person sent.
    view.rerender(
      <TypeBar
        send={send}
        lineRejection={{ commandType: 'HUMAN_LINE', reason: 'The meeting is not running' }}
      />,
    );
    expect(input.value).toBe('The stock count is in.');
    expect(screen.getByRole('alert').textContent).toBe(
      "Couldn't add your line: The meeting is not running",
    );
  });
});
