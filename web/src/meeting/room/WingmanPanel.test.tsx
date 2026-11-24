/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WingmanNotePayload } from '@kaki/shared';
import { WingmanPanel } from './WingmanPanel';

afterEach(() => {
  restoreTextHeights();
  cleanup();
});

const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

/** Makes jsdom report a clamped note's height, so the More/Less overflow check can be tested. */
function mockTextHeights(longTextLength: number): void {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return (this.textContent ?? '').length >= longTextLength ? 60 : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 20;
    },
  });
}

function restoreTextHeights(): void {
  if (originalScrollHeight === undefined) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  } else {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  }
  if (originalClientHeight === undefined) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  } else {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
  }
}

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
    // The question is already in these notes' text, so the trigger line names who and when only.
    expect(screen.getByText(`Ravi asked, ${clock}`)).toBeTruthy();
    expect(screen.getByText(`The room asked, ${clock}`)).toBeTruthy();
    expect(screen.queryByText(`Ravi asked, ${clock}: "When?"`)).toBeNull();
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

  it('clamps a long note to two lines, hiding its evidence until More, and collapses again on Less', () => {
    const longText =
      'The cash box moves to the back counter so the morning queue keeps moving and nobody waits at the door.';
    mockTextHeights(longText.length);
    const note: WingmanNotePayload = {
      id: 'answer:long',
      kind: 'answer',
      urgency: 'quiet',
      title: 'Wingman',
      text: longText,
      facts: [{ text: 'The cash box moves to the back counter.', source: 'wiki SOP', date: '2026-11-06' }],
      sources: ['wiki SOP (2026-11-06)'],
    };
    render(<WingmanPanel notes={[note]} onAsk={vi.fn(() => true)} onDismiss={vi.fn()} />);

    expect(screen.getByText(longText).getAttribute('data-clamp')).toBe('2');
    const more = screen.getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Facts in this note')).toBeNull();

    fireEvent.click(more);
    const less = screen.getByRole('button', { name: 'Less' });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Facts in this note')).toBeTruthy();
    expect(screen.getByText(longText).getAttribute('data-clamp')).toBeNull();

    fireEvent.click(less);
    expect(screen.getByRole('button', { name: 'More' })).toBeTruthy();
  });

  it('shows no More button for a note that fits in two lines, and keeps its evidence visible', () => {
    mockTextHeights(Number.MAX_SAFE_INTEGER);
    const note: WingmanNotePayload = {
      id: 'answer:short',
      kind: 'answer',
      urgency: 'quiet',
      title: 'Wingman',
      text: 'Short answer.',
      facts: [{ text: 'Short fact.', source: 'wiki SOP', date: '2026-11-06' }],
      sources: ['wiki SOP (2026-11-06)'],
    };
    render(<WingmanPanel notes={[note]} onAsk={vi.fn(() => true)} onDismiss={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.getByLabelText('Facts in this note')).toBeTruthy();
  });

  it('collapses an older history note to one line', () => {
    mockTextHeights(Number.MAX_SAFE_INTEGER);
    const cleared: WingmanNotePayload = {
      id: 'answer:old',
      kind: 'answer',
      urgency: 'quiet',
      title: 'Wingman',
      text: 'An older cleared answer.',
      clears: true,
      at: '2026-11-06T10:05:00.000Z',
    };
    render(
      <WingmanPanel notes={[]} history={[{ note: cleared }]} onAsk={vi.fn(() => true)} onDismiss={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Earlier · 1 more/ }));
    expect(screen.getByText('An older cleared answer.').getAttribute('data-clamp')).toBe('1');
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
