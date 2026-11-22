import { useEffect, useState, type FormEvent } from 'react';
import type { WingmanNotePayload } from '@kaki/shared';
import type { KakiRejection } from '../../kaki';

const KIND_LABELS: Record<WingmanNotePayload['kind'], string> = {
  answer: 'Answer',
  given: 'You were given',
  asked_you: 'Asked you',
  record: 'Record',
};

/** The facts and sources behind one private note, each with where it came from. */
function NoteEvidence({ note }: { note: WingmanNotePayload }) {
  const facts = note.facts ?? [];
  const sources = note.sources ?? [];
  if (facts.length === 0 && sources.length === 0) return null;
  return (
    <div className="kd-wingman-evidence">
      {facts.length > 0 && (
        <ul className="kd-wingman-facts" aria-label="Facts in this note">
          {facts.map((fact) => (
            <li key={`${fact.source}-${fact.date}-${fact.text}`}>
              <span>{fact.text}</span>
              <small>
                ({fact.source} · {fact.date})
              </small>
            </li>
          ))}
        </ul>
      )}
      {sources.length > 0 && (
        <p className="kd-wingman-sources">
          <span>Sources: </span>
          {sources.join(' · ')}
        </p>
      )}
    </div>
  );
}

/** The private Wingman panel: ask a question and read the notes only this seat may see. */
export function WingmanPanel({
  notes = [],
  onAsk,
  onDismiss,
  askRejection,
  onQuietCountChange,
}: {
  notes: readonly WingmanNotePayload[];
  onAsk(question: string): boolean;
  onDismiss(id: string): void;
  /** The server's last refusal of an ask, shown in the panel instead of silently doing nothing. */
  askRejection?: KakiRejection | null;
  /** Reports the quiet note count so the room can badge the Wingman without any motion. */
  onQuietCountChange?(count: number): void;
}) {
  const [question, setQuestion] = useState('');
  const quietCount = notes.filter((note) => note.urgency === 'quiet').length;

  useEffect(() => {
    onQuietCountChange?.(quietCount);
  }, [quietCount, onQuietCountChange]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = question.trim();
    if (trimmed === '') return;
    onAsk(trimmed);
  }

  const problem =
    askRejection?.commandType === 'ASK_WINGMAN' ? askRejection.reason : undefined;

  return (
    <section className="kd-role kd-wingman" aria-label="Wingman">
      <div className="kd-wingman-head">
        <p className="kd-role-eyebrow">Wingman</p>
        {quietCount > 0 && (
          <span
            className="kd-wingman-badge"
            aria-label={`${quietCount} private Wingman ${quietCount === 1 ? 'note' : 'notes'}`}
          >
            {quietCount}
          </span>
        )}
      </div>
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
      {problem !== undefined && (
        <p className="kd-wingman-problem" role="alert">
          {problem}
        </p>
      )}
      {notes.length === 0 ? (
        <p className="kd-hint kd-wingman-empty">Nothing private for you right now.</p>
      ) : (
        <ul className="kd-wingman-notes">
          {notes.map((note) => (
            <li
              key={note.id}
              className="kd-wingman-note"
              data-kind={note.kind}
              data-urgency={note.urgency}
            >
              <div className="kd-wingman-note-head">
                <span className="kd-wingman-kind">{KIND_LABELS[note.kind]}</span>
                <b>{note.title}</b>
                <button
                  type="button"
                  className="kd-wingman-dismiss"
                  aria-label={`Dismiss ${note.title}`}
                  onClick={() => onDismiss(note.id)}
                >
                  ✕
                </button>
              </div>
              {note.questionText !== undefined && (
                <p className="kd-wingman-question">You asked: {note.questionText}</p>
              )}
              <p className="kd-wingman-text">{note.text}</p>
              <NoteEvidence note={note} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The one thing allowed in the middle of the screen: a direct question waiting for this person.
 * It is not shown again after Close, and a clears event from the server removes it for good.
 */
export function WingmanActNow({
  notes = [],
  onDismiss,
}: {
  notes: readonly WingmanNotePayload[];
  onDismiss(id: string): void;
}) {
  const [closedId, setClosedId] = useState<string | undefined>(undefined);
  const active = [...notes].reverse().find((note) => note.urgency === 'act_now');

  useEffect(() => {
    setClosedId((previous) =>
      previous !== undefined && notes.some((note) => note.id === previous) ? previous : undefined,
    );
  }, [notes]);

  if (active === undefined || active.id === closedId) return null;

  function close(): void {
    if (active === undefined) return;
    setClosedId(active.id);
    onDismiss(active.id);
  }

  return (
    <div className="kd-act-now">
      <div className="kd-act-now-card" role="alertdialog" aria-label="Wingman asks you now">
        <p className="kd-role-eyebrow">Wingman · Asked you</p>
        <h2 className="kd-act-now-title">{active.title}</h2>
        <p className="kd-wingman-text">{active.text}</p>
        <NoteEvidence note={active} />
        <button type="button" className="kd-chip" onClick={close}>
          Close
        </button>
      </div>
    </div>
  );
}
