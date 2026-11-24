import { useLayoutEffect, useRef, useState } from 'react';
import type { WingmanNotePayload } from '@kaki/shared';
import type { WingmanHistoryEntry } from '../../kaki';

const KIND_LABELS: Record<WingmanNotePayload['kind'], string> = {
  answer: 'Answer',
  given: 'You were given',
  asked_you: 'Asked you',
  record: 'Record',
  lead: 'Quiet item',
  nudge: 'Your item',
};

/** The facts and sources behind one private note, each with where it came from. */
function NoteEvidence({ note }: { note: WingmanNotePayload }) {
  // A fact already written out in the note's text is not repeated; its source still shows below.
  const allFacts = note.facts ?? [];
  const facts = allFacts.filter((fact) => !note.text.includes(fact.text.trim()));
  const sources = [
    ...new Set([...allFacts.map((fact) => `${fact.source} (${fact.date})`), ...(note.sources ?? [])]),
  ];
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

function clockTime(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const parsed = Date.parse(at);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The line that caused one hint, from the explicit asker the server put on the note. */
function triggerText(entry: WingmanHistoryEntry): string | undefined {
  const question = entry.note.questionText?.trim();
  if (question === undefined || question === '') return undefined;
  const time = clockTime(entry.note.at);
  const when = time === undefined ? '' : `, ${time}`;
  const asked =
    entry.note.questionFrom === 'you'
      ? 'You asked'
      : entry.note.questionFrom === 'person'
        ? `${entry.note.askedBy?.trim() || 'Someone'} asked`
        : entry.note.questionFrom === 'room'
          ? 'The room asked'
          : 'Question';
  // A note that already relays the question in its text is not quoted twice.
  if (entry.note.text.includes(question.slice(0, 40))) return `${asked}${when}`;
  return `${asked}${when}: "${question}"`;
}

function HistoryNote({
  entry,
  active,
  collapsedLines,
  onDismiss,
}: {
  entry: WingmanHistoryEntry;
  active: boolean;
  /** Lines the note shows before More: 2 for a live note, 1 for an older one. */
  collapsedLines: number;
  onDismiss?: (id: string) => void;
}) {
  const { note } = entry;
  const trigger = triggerText(entry);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Whether the clamped note actually overflows. A short note needs no More button and shows its
  // evidence straight away; only a note that would flood the panel starts collapsed.
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    // Measure only while clamped: an expanded note fills its box, so it would always look short.
    if (expanded) return;
    const element = textRef.current;
    if (element === null) return;
    setOverflowing(element.scrollHeight > element.clientHeight);
  }, [expanded, note.text, collapsedLines]);

  const showAll = expanded || !overflowing;

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
      <p
        ref={textRef}
        className="kd-wingman-text"
        data-clamp={expanded ? undefined : collapsedLines}
        style={
          expanded
            ? undefined
            : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: collapsedLines,
                overflow: 'hidden',
              }
        }
      >
        {note.text}
      </p>
      {overflowing ? (
        <button
          type="button"
          className="kd-wingman-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? 'Less' : 'More'}
        </button>
      ) : null}
      {showAll ? <NoteEvidence note={note} /> : null}
    </li>
  );
}

/**
 * Every private hint this seat saw this meeting: the still-active ones stay open at the top (an
 * act-now question first), each group newest first. Cleared notes stay below behind one Show/Hide
 * line, so the visitor can still read what Wingman said.
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
  const indexed = entries.map((entry, index) => ({ entry, index }));
  const active = indexed
    .filter(({ entry }) => entry.note.clears !== true)
    .sort(
      (left, right) =>
        Number(right.entry.note.urgency === 'act_now') - Number(left.entry.note.urgency === 'act_now') ||
        right.index - left.index,
    )
    .map(({ entry }) => entry);
  const earlier = indexed
    .filter(({ entry }) => entry.note.clears === true)
    .sort((left, right) => right.index - left.index)
    .map(({ entry }) => entry);
  const isActive = (entry: WingmanHistoryEntry): boolean =>
    activeIds === undefined || activeIds.has(entry.note.id);
  return (
    <div className="kd-wingman-history">
      {active.length === 0 ? null : (
        <ul className="kd-wingman-notes">
          {active.map((entry) => (
            <HistoryNote
              key={entry.note.id}
              entry={entry}
              active={isActive(entry)}
              collapsedLines={2}
              {...(onDismiss === undefined ? {} : { onDismiss })}
            />
          ))}
        </ul>
      )}
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
              active={isActive(entry)}
              collapsedLines={1}
              {...(onDismiss === undefined ? {} : { onDismiss })}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
