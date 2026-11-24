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
  it('does not repeat a fact already written in the answer, but keeps its source once', () => {
    const note: WingmanNotePayload = {
      id: 'answer:dup', kind: 'answer', urgency: 'quiet', title: 'Wingman',
      text: 'Kopi is $2.40 a cup. The till can add a button.',
      facts: [
        { text: 'Kopi is $2.40 a cup.', source: 'Wiki: Pricing', date: '2026-11-11' },
        { text: 'Regulars come before 8.', source: 'Wiki: Floor', date: '2026-11-10' },
      ],
      sources: ['Wiki: Pricing (2026-11-11)'],
    };
    render(<WingmanPanel notes={[note]} onAsk={vi.fn(() => true)} onDismiss={vi.fn()} />);
    const facts = screen.getByLabelText('Facts in this note');
    expect(facts.textContent).not.toContain('Kopi is $2.40 a cup.');
    expect(facts.textContent).toContain('Regulars come before 8.');
    expect(screen.getByText(/Sources:/).parentElement?.textContent).toBe(
      'Sources: Wiki: Pricing (2026-11-11) · Wiki: Floor (2026-11-10)',
    );
  });

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
          { note: { ...quietNotes[0]!, clears: true, at: '2026-11-06T10:05:00.000Z' } },
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

  it('keeps every active note open at the top, act-now first, and cleared notes behind Earlier', () => {
    const at = '2026-11-06T10:05:00.000Z';
    const olderQuiet: WingmanNotePayload = {
      id: 'record:chef:1', kind: 'record', urgency: 'quiet', title: 'Records on this', text: 'Older quiet.', at,
    };
    const newerQuiet: WingmanNotePayload = {
      id: 'given:chef:task-2', kind: 'given', urgency: 'quiet', title: 'You were given a to-do', text: 'Newer quiet.', at,
    };
    const question: WingmanNotePayload = {
      id: 'asked:chef', kind: 'asked_you', urgency: 'act_now', title: 'Ravi asked you',
      text: 'Ravi asked you: When?', questionText: 'When?', questionFrom: 'person', askedBy: 'Ravi', at,
    };
    const cleared: WingmanNotePayload = {
      id: 'answer:chef', kind: 'answer', urgency: 'quiet', title: 'Wingman', text: 'Already cleared.', clears: true, at,
    };
    render(
      <WingmanPanel
        notes={[olderQuiet, newerQuiet, question]}
        history={[
          { note: olderQuiet },
          { note: newerQuiet },
          { note: question },
          { note: cleared },
        ]}
        onAsk={vi.fn(() => true)}
        onDismiss={vi.fn()}
      />,
    );

    const shown = [...document.querySelectorAll('.kd-wingman-note')].map((node) => node.textContent);
    expect(shown).toHaveLength(3);
    expect(shown[0]).toContain('Ravi asked you');
    expect(shown[1]).toContain('Newer quiet.');
    expect(shown[2]).toContain('Older quiet.');
    expect(screen.queryByText('Already cleared.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Earlier · 1 more/ }));
    expect(screen.getByText('Already cleared.')).toBeTruthy();
  });

  it('names who asked, with the server time, for the reader, a person, and the room', () => {
    const at = '2026-11-06T10:05:00.000Z';
    const clock = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const notes: WingmanNotePayload[] = [
      {
        id: 'answer:chef', kind: 'answer', urgency: 'quiet', title: 'Wingman',
        text: 'An answer.', questionText: 'what did we decide?', questionFrom: 'you', at,
      },
      {
        id: 'asked:chef', kind: 'asked_you', urgency: 'act_now', title: 'Ravi asked you',
        text: 'Ravi asked you: When?', questionText: 'When?', questionFrom: 'person', askedBy: 'Ravi', at,
      },
      {
        id: 'room:chef', kind: 'asked_you', urgency: 'quiet', title: 'The room asked you',
        text: 'The room asked you: Which option?', questionText: 'Which option?', questionFrom: 'room', at,
      },
    ];
    render(<WingmanPanel notes={notes} onAsk={vi.fn(() => true)} onDismiss={vi.fn()} />);

    expect(screen.getByText(`You asked, ${clock}: "what did we decide?"`)).toBeTruthy();
    expect(screen.getByText(`Ravi asked, ${clock}: "When?"`)).toBeTruthy();
    expect(screen.getByText(`The room asked, ${clock}: "Which option?"`)).toBeTruthy();
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
