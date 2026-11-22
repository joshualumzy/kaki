/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WingmanNotePayload } from '@kaki/shared';
import { WingmanActNow, WingmanPanel } from './WingmanPanel';

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

const asked: WingmanNotePayload = {
  id: 'asked:chef',
  kind: 'asked_you',
  urgency: 'act_now',
  title: 'Ravi asked you',
  text: 'Ravi asked you: What should the kiosk do at 8?',
  facts: [{ text: 'The kiosk accepts notes.', source: 'Gitea ticket', date: '2026-11-05' }],
  sources: ['Gitea ticket (2026-11-05)'],
};

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

  it('dismisses one note by its id', () => {
    const onDismiss = vi.fn();
    render(<WingmanPanel notes={quietNotes} onAsk={vi.fn(() => true)} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Wingman' }));

    expect(onDismiss).toHaveBeenCalledWith('answer:chef');
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

describe('WingmanActNow', () => {
  it('shows the direct question in the middle and closes it', () => {
    const onDismiss = vi.fn();
    render(<WingmanActNow notes={[asked]} onDismiss={onDismiss} />);

    const card = screen.getByRole('alertdialog', { name: 'Wingman asks you now' });
    expect(within(card).getByText('Ravi asked you')).toBeTruthy();
    expect(within(card).getByText('Ravi asked you: What should the kiosk do at 8?')).toBeTruthy();
    expect(within(card).getByText('The kiosk accepts notes.')).toBeTruthy();
    expect(within(card).getByText('Gitea ticket (2026-11-05)')).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Close' }));
    expect(onDismiss).toHaveBeenCalledWith('asked:chef');
    expect(screen.queryByRole('alertdialog', { name: 'Wingman asks you now' })).toBeNull();
  });

  it('removes the card when the server clears the note', () => {
    const onDismiss = vi.fn();
    const view = render(<WingmanActNow notes={[asked]} onDismiss={onDismiss} />);

    view.rerender(<WingmanActNow notes={[]} onDismiss={onDismiss} />);

    expect(screen.queryByRole('alertdialog', { name: 'Wingman asks you now' })).toBeNull();
  });

  it('lets the same id pop again only after the server clears it', () => {
    const onDismiss = vi.fn();
    const view = render(<WingmanActNow notes={[asked]} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alertdialog', { name: 'Wingman asks you now' })).toBeNull();

    view.rerender(<WingmanActNow notes={[]} onDismiss={onDismiss} />);
    view.rerender(<WingmanActNow notes={[asked]} onDismiss={onDismiss} />);
    expect(screen.getByRole('alertdialog', { name: 'Wingman asks you now' })).toBeTruthy();
  });

  it('leaves quiet notes out of the middle of the screen', () => {
    render(<WingmanActNow notes={quietNotes} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('alertdialog', { name: 'Wingman asks you now' })).toBeNull();
  });
});
