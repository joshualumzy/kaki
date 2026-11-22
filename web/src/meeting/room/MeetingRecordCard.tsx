import { useEffect, useMemo, useState } from 'react';
import { roleLabel, type KakiEvent, type Scenario } from '@kaki/shared';
import { Card } from '../../ui';

/** A meeting-record update, the event that carries the clock and agenda position. */
export type RecordEvent = Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>;

/** Narrows a meeting event to a record update. */
export function isRecord(event: KakiEvent): event is RecordEvent {
  return event.type === 'MEETING_RECORD_UPDATED';
}

/**
 * The server sends a record only when something changes, plus a heartbeat every 30 s of meeting
 * time, so count up locally in between. Stop a little after a missed heartbeat: the meeting may be over.
 */
const MAX_COUNT_UP_SECONDS = 35;

function useCountUp(elapsedSeconds: number, record: RecordEvent, frozen = false): number {
  // Each record is a new object, so this restarts the count whenever one arrives.
  const receivedAt = useMemo(() => Date.now(), [record]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozen) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [frozen]);
  if (frozen) return elapsedSeconds;
  return elapsedSeconds + Math.min(MAX_COUNT_UP_SECONDS, Math.max(0, (now - receivedAt) / 1000));
}

function formatMinutes(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(Math.floor(totalSeconds % 60)).padStart(2, '0')}`;
}

/** The compact Host card: the clock, agenda steps, and (once the meeting ends) its unanswered questions. */
export function MeetingRecordCard({
  record,
  scenario,
  ended = false,
  showOpenQuestions = true,
  hideWhenEmptyAgenda = false,
}: {
  record: RecordEvent;
  scenario: Scenario;
  ended?: boolean;
  showOpenQuestions?: boolean;
  /** A real meeting with no agenda has no clock or item to show, so the card stays out of the way. */
  hideWhenEmptyAgenda?: boolean;
}) {
  const { agendaIndex, openQuestions, paused, reviewIssues = [] } = record.payload;
  const elapsed = useCountUp(record.payload.elapsedSeconds, record, ended || paused === true);
  const item = scenario.agenda[agendaIndex];
  const limit = (item?.minutes ?? 0) * 60;
  const over = limit > 0 && elapsed >= limit;
  if (hideWhenEmptyAgenda && scenario.agenda.length === 0) return null;

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="eyebrow" style={{ marginBottom: 2 }}>
            {ended
              ? `Meeting ended · ${scenario.agenda.length} of ${scenario.agenda.length} items completed`
              : `Now · item ${agendaIndex + 1} of ${scenario.agenda.length}`}
          </p>
          <h2 className="card-title" style={{ margin: 0, fontSize: 16 }}>{item?.title ?? 'Meeting'}</h2>
        </div>
        <div className="kd-host-clock" style={{ flexShrink: 0 }}>
          {formatMinutes(elapsed)}{' '}
          <small style={{ fontSize: 12, fontWeight: 500, opacity: 0.75 }}>
            {ended ? 'concluded' : paused ? 'paused' : over ? 'over time' : `of ${formatMinutes(limit)}`}
          </small>
        </div>
      </div>
      <div className="kd-host-bar">
        <i style={{ width: `${ended ? 100 : limit === 0 ? 0 : Math.min(100, (elapsed / limit) * 100)}%` }} />
      </div>
      {scenario.agenda.length > 1 && (
        <ol className="sc-steps" style={{ marginTop: 10, marginBottom: showOpenQuestions && openQuestions.length > 0 ? 10 : 0 }}>
          {scenario.agenda.map((step, index) => (
            <li key={step.title} data-state={ended || index < agendaIndex ? 'done' : index === agendaIndex ? 'now' : 'next'}>
              <i />
              <span>{step.title}</span>
              <em>{step.minutes}m</em>
            </li>
          ))}
        </ol>
      )}
      {showOpenQuestions && openQuestions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p className="eyebrow" style={{ marginBottom: 4 }}>
            {ended ? 'Unanswered questions' : 'Open questions'} · {openQuestions.length}
          </p>
          <ul className="sc-questions" style={{ margin: 0, paddingLeft: 18 }}>
            {openQuestions.map((question) => (
              <li key={question.id}>
                {question.text}
                {question.forRole === undefined ? null : <em> · {roleLabel(scenario, question.forRole)}</em>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {reviewIssues.length > 0 && (
        <div style={{ marginTop: 10 }} role="status">
          <p className="eyebrow" style={{ marginBottom: 4 }}>Needs a person's eye · {reviewIssues.length}</p>
          <ul className="sc-questions" style={{ margin: 0, paddingLeft: 18 }}>
            {reviewIssues.map((issue) => (
              <li key={issue.id}>{issue.text}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
