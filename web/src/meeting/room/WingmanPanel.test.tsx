/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WingmanNotePayload } from '@kaki/shared';
import { WingmanPanel } from './WingmanPanel';

afterEach(cleanup);

const quietNotes: WingmanNotePayload[] = [
  {
    id: 'answer:chef',
    kind: 'answer',
    urgency: 'quiet',
    title: 'Wingman',
    text: 'You asked what we decided: the cash box moves.',
    facts: [{ text: 'The shop still has launch budget left.', source: 'wiki SOP', date: '2026-11-06' }],
    sources: ['wiki SOP (2026-11-06)'],
  },
  {
    id: 'given:chef:task-1',
    kind: 'given',
    urgency: 'quiet',
    title: 'You were given a to-do',
    text: 'You were given: Post the cash box decision.',
  },
];


describe('WingmanPanel', () => {
  it('shows the quiet note count as a badge with no reminder motion', () => {
    const { container } = render(
      <WingmanPanel notes={quietNotes} onAsk={vi.fn(() => true)} onDismiss={vi.fn()} />,
    );
    const badge = screen.getByLabelText('2 private Wingman notes');
    expect(badge.textContent).toBe('2');
    expect(badge.className).not.toContain('kd-ping');
    expect(container.querySelector('.kd-wingman')).toBeTruthy();
  });

  it('asks the Wingman with the question the person typed', () => {
    const onAsk = vi.fn(() => true);
    render(<WingmanPanel notes={[]} onAsk={onAsk} onDismiss={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Ask Kaki about this meeting'), {
      target: { value: '  what did we decide?  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    expect(onAsk).toHaveBeenCalledWith('what did we decide?');
  });

  it('dismisses the newest note by its id', () => {
    const onDismiss = vi.fn();
    render(<WingmanPanel notes={quietNotes} onAsk={vi.fn(() => true)} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss You were given a to-do' }));

    expect(onDismiss).toHaveBeenCalledWith('given:chef:task-1');
  });

  it('keeps a cleared note in history, readable behind Earlier', () => {
    render(
      <WingmanPanel
        notes={[quietNotes[1]!]}
        history={[
          { note: { ...quietNotes[0]!, clears: true }, at: Date.parse('2026-11-06T10:05:00.000Z') },
          { note: quietNotes[1]! },
        ]}
        onAsk={vi.fn(() => true)}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.queryByText(quietNotes[0]!.text)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Earlier · 1 more/ }));
    expect(screen.getByText(quietNotes[0]!.text)).toBeTruthy();
    expect(screen.getByText(quietNotes[0]!.facts![0]!.text)).toBeTruthy();
  });

  it('shows an ask refusal in the panel', () => {
    render(
      <WingmanPanel
        notes={[]}
        onAsk={vi.fn(() => true)}
        onDismiss={vi.fn()}
        askRejection={{ commandType: 'ASK_WINGMAN', reason: 'Only a person in a seat can ask the Wingman' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Only a person in a seat can ask the Wingman');
  });
});

describe('WingmanPanel waiting', () => {
  it('says Wingman is thinking, then gives up after 20 seconds and keeps the question', () => {
    vi.useFakeTimers();
    try {
      render(<WingmanPanel notes={[]} onAsk={() => true} onDismiss={() => undefined} />);
      const field = screen.getByLabelText('Ask Kaki about this meeting') as HTMLInputElement;
      fireEvent.change(field, { target: { value: 'What did we decide?' } });
      fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
      expect(screen.getByText('Wingman is thinking…')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(20_000);
      });
      expect(screen.getByRole('alert').textContent).toBe("Wingman didn't answer. Ask again.");
      expect(field.value).toBe('What did we decide?');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when the question could not be sent', () => {
    render(<WingmanPanel notes={[]} onAsk={() => false} onDismiss={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Ask Kaki about this meeting'), { target: { value: 'Hi?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(screen.getByRole('alert').textContent).toContain('not sent');
    expect(screen.queryByText('Wingman is thinking…')).toBeNull();
  });
});
