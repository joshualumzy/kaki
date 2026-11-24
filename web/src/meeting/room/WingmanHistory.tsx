import { useState } from 'react';
import type { WingmanNotePayload } from '@kaki/shared';
import type { WingmanHistoryEntry } from '../../kaki';

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

function clockTime(at: number | undefined): string | undefined {
  if (at === undefined || !Number.isFinite(at)) return undefined;
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The line that caused one hint, when the note answers a question. */
function triggerText(entry: WingmanHistoryEntry): string | undefined {
  const question = entry.note.questionText?.trim();
  if (question === undefined || question === '') return undefined;
  const askedBy = /^(.+?) asked you/i.exec(entry.note.title)?.[1]?.trim() ?? 'Question';
  const time = clockTime(entry.at);
  return `${askedBy} asked${time === undefined ? '' : `, ${time}`}: "${question}"`;
}

function HistoryNote({
  entry,
  active,
  onDismiss,
}: {
  entry: WingmanHistoryEntry;
  active: boolean;
  onDismiss?: (id: string) => void;
}) {
  const { note } = entry;
  const trigger = triggerText(entry);
  return (
    <li className="kd-wingman-note" data-kind={note.kind} data-urgency={note.urgency}>
      <div className="kd-wingman-note-head">
        <span className="kd-wingman-kind">{KIND_LABELS[note.kind]}</span>
        <b>{note.title}</b>
        {active && onDismiss !== undefined ? (
          <button
            type="button"
            className="kd-wingman-dismiss"
            aria-label={`Dismiss ${note.title}`}
            onClick={() => onDismiss(note.id)}
          >
            ✕
          </button>
        ) : null}
      </div>
      {trigger !== undefined ? <p className="kd-wingman-trigger">{trigger}</p> : null}
      {note.questionText !== undefined && trigger === undefined ? (
        <p className="kd-wingman-question">You asked: {note.questionText}</p>
      ) : null}
      <p className="kd-wingman-text">{note.text}</p>
      <NoteEvidence note={note} />
    </li>
  );
}

/**
 * Every private hint this seat saw this meeting, newest first: the latest is open, older ones sit
 * behind one Show/Hide line. A cleared note stays here, so the visitor can still read what Wingman said.
 */
export function WingmanHistory({
  entries,
  activeIds,
  onDismiss,
}: {
  entries: readonly WingmanHistoryEntry[];
  /** The ids still active for this seat; only those offer Dismiss. */
  activeIds?: ReadonlySet<string>;
  onDismiss?(id: string): void;
}) {
  const [showEarlier, setShowEarlier] = useState(false);
  if (entries.length === 0) {
    return <p className="kd-hint kd-wingman-empty">Nothing private for you right now.</p>;
  }
  const newest = entries[entries.length - 1]!;
  const earlier = entries.slice(0, -1).reverse();
  return (
    <div className="kd-wingman-history">
      <ul className="kd-wingman-notes">
        <HistoryNote
          entry={newest}
          active={activeIds === undefined || activeIds.has(newest.note.id)}
          {...(onDismiss === undefined ? {} : { onDismiss })}
        />
      </ul>
      {earlier.length === 0 ? null : (
        <button
          type="button"
          className="kd-wingman-earlier"
          aria-expanded={showEarlier}
          onClick={() => setShowEarlier((previous) => !previous)}
        >
          {showEarlier ? 'Hide earlier' : `Earlier · ${earlier.length} more`}
        </button>
      )}
      {showEarlier && earlier.length > 0 ? (
        <ul className="kd-wingman-notes">
          {earlier.map((entry) => (
            <HistoryNote
              key={entry.note.id}
              entry={entry}
              active={activeIds === undefined || activeIds.has(entry.note.id)}
              {...(onDismiss === undefined ? {} : { onDismiss })}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
