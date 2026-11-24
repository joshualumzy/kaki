import { useEffect, useState, type FormEvent } from 'react';
import type { WingmanNotePayload } from '@kaki/shared';
import type { KakiRejection, WingmanHistoryEntry } from '../../kaki';
import { DID_NOT_WORK, plainServerText } from '../../net/plainFailure';
import { WingmanHistory } from './WingmanHistory';

/** How long an ask may go unanswered before the panel says so. */
const ASK_WAIT_MS = 20_000;

/** The private Wingman panel: ask a question and read the hints only this seat may see. */
export function WingmanPanel({
  notes = [],
  history,
  onAsk,
  onDismiss,
  askRejection,
  onQuietCountChange,
}: {
  notes: readonly WingmanNotePayload[];
  /** Every hint this seat saw, including cleared ones. Falls back to the active notes. */
  history?: readonly WingmanHistoryEntry[];
  onAsk(question: string): boolean;
  onDismiss(id: string): void;
  /** The server's last refusal of an ask, shown in the panel instead of silently doing nothing. */
  askRejection?: KakiRejection | null;
  /** Reports the quiet note count so the room can badge the Wingman without any motion. */
  onQuietCountChange?(count: number): void;
}) {
  const [question, setQuestion] = useState('');
  // The ask in flight: what the panel showed when it was sent, so any new note or refusal ends the wait.
  const [waiting, setWaiting] = useState<{
    knownIds: ReadonlySet<string>;
    rejection: KakiRejection | null | undefined;
  } | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [notSent, setNotSent] = useState(false);
  const quietCount = notes.filter((note) => note.urgency === 'quiet').length;
  const entries = history ?? notes.map((note) => ({ note }));
  const activeIds = new Set(notes.map((note) => note.id));

  useEffect(() => {
    onQuietCountChange?.(quietCount);
  }, [quietCount, onQuietCountChange]);

  useEffect(() => {
    if (waiting === null) return;
    if (askRejection !== waiting.rejection || notes.some((note) => !waiting.knownIds.has(note.id))) {
      setWaiting(null);
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), ASK_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [waiting, notes, askRejection]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed === '') return;
    setTimedOut(false);
    setNotSent(false);
    if (!onAsk(trimmed)) {
      setWaiting(null);
      setNotSent(true);
      return;
    }
    setWaiting({ knownIds: new Set(notes.map((note) => note.id)), rejection: askRejection });
  }

  const problem =
    notSent || (askRejection?.commandType === 'ASK_WINGMAN' && askRejection.reason === 'not connected')
    ? 'Your question was not sent. Check your connection and ask again.'
    : timedOut
      ? "Wingman didn't answer. Ask again."
      : askRejection?.commandType === 'ASK_WINGMAN'
        ? (plainServerText(askRejection.reason) ?? DID_NOT_WORK)
        : undefined;
  const thinking = waiting !== null && !timedOut;

  return (
    <section className="kd-role kd-wingman" aria-label="Wingman">
      <p className="kd-wingman-hint">
        Answers come from company records, with a source.
        {quietCount > 0 && (
          <span
            className="kd-wingman-badge"
            aria-label={`${quietCount} private Wingman ${quietCount === 1 ? 'note' : 'notes'}`}
          >
            {quietCount}
          </span>
        )}
      </p>
      <form className="kd-wingman-ask" onSubmit={submit}>
        <label className="kd-label" htmlFor="kd-wingman-question">
          Ask Kaki about this meeting
        </label>
        <div className="kd-wingman-ask-row">
          <input
            id="kd-wingman-question"
            className="kd-field"
            value={question}
            maxLength={300}
            placeholder="What did we decide?"
            autoComplete="off"
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button type="submit" className="kd-chip" disabled={question.trim() === ''}>
            Ask
          </button>
        </div>
      </form>
      {thinking && (
        <p className="kd-hint" role="status">
          Wingman is thinking…
        </p>
      )}
      {problem !== undefined && (
        <p className="kd-wingman-problem" role="alert">
          {problem}
        </p>
      )}
      <WingmanHistory entries={entries} activeIds={activeIds} onDismiss={onDismiss} />
    </section>
  );
}
