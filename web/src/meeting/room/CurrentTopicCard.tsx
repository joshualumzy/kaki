import { useMemo } from 'react';
import {
  assigneeLabel,
  catchPosition,
  type AgendaItem,
  type KakiEvent,
  type Scenario,
  type ScenarioRole,
} from '@kaki/shared';
import type { TranscriptViewer } from './captions';

export type FactEvent = Extract<KakiEvent, { type: 'FACT_FOUND' }>;

function sourceBadgeText(source: string): string {
  const lower = source.toLowerCase();
  if (lower.includes('gitea') || lower.includes('issue') || lower.includes('ticket')) return '🐛 Gitea Ticket';
  if (lower.includes('mattermost') || lower.includes('chat') || lower.includes('channel')) return '💬 Team Chat';
  if (lower.includes('wiki') || lower.includes('sop') || lower.includes('doc') || lower.includes('guide')) return '📖 Wiki SOP';
  if (lower.includes('mail') || lower.includes('email')) return '📧 Email';
  if (lower.includes('sql') || lower.includes('postgres') || lower.includes('table')) return '📊 Store DB';
  return '📁 Record';
}

/**
 * Compact context card for the current agenda item so the visitor has the decision and any facts
 * from their own role that match this topic right above the transcript.
 */
export function CurrentTopicCard({
  item,
  scenario,
  role,
  viewer,
  companyFact,
  liveWingmanBrief,
  events,
  agendaIndex,
}: {
  item: AgendaItem | undefined;
  scenario: Scenario;
  role: ScenarioRole | undefined;
  viewer: TranscriptViewer;
  companyFact: FactEvent | undefined;
  liveWingmanBrief?: string;
  events?: readonly KakiEvent[];
  agendaIndex?: number;
}) {
  if (item === undefined) return null;
  const isMyItem = role !== undefined && item.ownerRole === role.id;
  const myFacts = role !== undefined && item.seatFacts?.[role.id] !== undefined ? [item.seatFacts[role.id]!] : [];
  const ownerName = assigneeLabel(scenario, item.ownerRole, viewer);
  const roleBadge = isMyItem
    ? `Your Item to Lead (${role?.label ?? 'Owner'})`
    : `Topic Owner: ${ownerName}`;

  // Only the catches the room has actually raised on this topic, in the order they were heard.
  const raisedCatchIds = useMemo(() => {
    const ids = new Map<string, true>();
    for (const event of events ?? []) {
      if (event.type !== 'TRANSCRIPT_CHUNK') continue;
      const { catchId } = event.payload;
      const position = catchPosition(catchId);
      if (catchId === undefined || position === undefined) continue;
      if (agendaIndex !== undefined && position.agendaIndex !== agendaIndex) continue;
      ids.delete(catchId);
      ids.set(catchId, true);
    }
    return [...ids.keys()];
  }, [events, agendaIndex]);

  const visibleTradeOffs = useMemo(() => {
    const tradeOffs = item.discussion?.tradeOffs ?? [];
    const isVisitorSeat = (to: (typeof tradeOffs)[number]) => {
      if (role?.id !== undefined && to.role === role.id) return true;
      if (to.attendee.toLowerCase() === viewer.name.toLowerCase()) return true;
      if (viewer.seatName !== undefined && to.attendee.toLowerCase() === viewer.seatName.toLowerCase()) return true;
      return false;
    };

    const seen = new Map<number, true>();
    for (const id of raisedCatchIds) {
      const position = catchPosition(id);
      if (position === undefined) continue;
      const tradeOff = tradeOffs[position.tradeOffIndex];
      if (tradeOff === undefined || isVisitorSeat(tradeOff)) continue;
      seen.delete(position.tradeOffIndex);
      seen.set(position.tradeOffIndex, true);
    }
    return [...seen.keys()].slice(-3).map((index) => tradeOffs[index]!);
  }, [item, raisedCatchIds, viewer, role]);

  const companyFacts =
    companyFact === undefined
      ? []
      : filterNonDuplicateCompanyFacts(companyFact.payload.facts, [
          ...myFacts,
          ...visibleTradeOffs.map((to) => to.tradeOff),
        ]);

  const heroFacts = liveWingmanBrief !== undefined ? [liveWingmanBrief] : myFacts.slice(0, 1);

  const hasTradeOffList = item.discussion?.tradeOffs !== undefined && item.discussion.tradeOffs.length > 0;
  // Until the room has raised a catch, keep the Wingman card out of the way unless it has something else to say.
  if (hasTradeOffList && visibleTradeOffs.length === 0 && companyFacts.length === 0 && liveWingmanBrief === undefined) return null;
  if (!hasTradeOffList && heroFacts.length === 0 && companyFacts.length === 0) return null;

  return (
    <section className="kd-role kd-topic-card" aria-label="Current topic context">
      <p className="kd-role-eyebrow">Wingman · {roleBadge}</p>
      {heroFacts.length > 0 && (!hasTradeOffList || visibleTradeOffs.length > 0 || liveWingmanBrief !== undefined) && (
        <div style={{ marginTop: 6, marginBottom: 8 }}>
          <p className="kd-role-eyebrow" style={{ marginBottom: 4 }}>
            {liveWingmanBrief !== undefined
              ? '✨ Live Wingman Brief (Adapted to Discussion)'
              : `💡 Your Fact to Share (${role?.label ?? 'Your Role'})`}
          </p>
          <div className="kd-fact-chips" aria-label="Key facts for this topic">
            {heroFacts.map((fact) => (
              <div key={fact} className="kd-fact-chip kd-fact-chip-hero">
                {fact}
              </div>
            ))}
          </div>
        </div>
      )}
      {((hasTradeOffList && visibleTradeOffs.length > 0) || (companyFact !== undefined && companyFacts.length > 0)) && (
        <details className="kd-topic-details">
          <summary className="kd-topic-details-summary">
            <span>
              Supporting details ·{' '}
              {hasTradeOffList && visibleTradeOffs.length > 0 ? 'Both sides' : ''}
              {hasTradeOffList && visibleTradeOffs.length > 0 && companyFact !== undefined && companyFacts.length > 0
                ? ' & '
                : ''}
              {companyFact !== undefined && companyFacts.length > 0 ? 'Company records' : ''}
            </span>
            <span className="kd-briefing-toggle">Details ▾</span>
          </summary>
          <div className="kd-topic-details-body">
            {hasTradeOffList && visibleTradeOffs.length > 0 && (
              <div style={{ marginTop: 6, marginBottom: 8 }}>
                <p className="kd-role-eyebrow" style={{ marginBottom: 4 }}>Both Sides of the Issue</p>
                <ul className="kd-record-list" style={{ marginBottom: 0 }}>
                  {visibleTradeOffs.map((to) => {
                    const colonIndex = to.tradeOff.indexOf(':');
                    const hasHeadline = colonIndex > 0 && colonIndex < 45;
                    const headline = hasHeadline ? to.tradeOff.slice(0, colonIndex).trim() : null;
                    const detail = hasHeadline ? to.tradeOff.slice(colonIndex + 1).trim() : to.tradeOff;
                    return (
                      <li key={to.tradeOff} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <span className="kd-record-source-pill" style={{ flexShrink: 0 }}>{to.attendee}</span>
                        <span style={{ fontSize: 13, lineHeight: '1.4' }}>
                          {headline !== null ? (
                            <>
                              <strong>{headline}:</strong> {detail}
                            </>
                          ) : (
                            detail
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {companyFact !== undefined && companyFacts.length > 0 && (
              <div style={{ marginTop: hasTradeOffList && visibleTradeOffs.length > 0 ? 10 : 6 }}>
                <p className="kd-role-eyebrow" style={{ marginBottom: 4 }}>
                  From the company records · {companyFact.payload.question}
                </p>
                <ul className="kd-record-list" style={{ marginBottom: 0 }}>
                  {companyFacts.slice(0, 2).map((fact, index) => (
                    <li key={`${fact.source}-${fact.date}-${index}`}>
                      <span className="kd-record-source-pill">{sourceBadgeText(fact.source)}</span>
                      <span>{fact.text}</span>
                      <small>({fact.source} · {fact.date})</small>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

const GENERIC_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'what', 'when', 'who', 'how', 'why', 'where',
  'your', 'you', 'our', 'their', 'they', 'will', 'can', 'just', 'more', 'first',
  'build', 'game', 'launch', 'team', 'time', 'open', 'issue', 'issues', 'before',
  'order', 'morning', 'staff',
  'customers', 'handle', 'without', 'make', 'keep', 'turn', 'turned', 'away',
]);

/** Drop company-record bullets that repeat each other or the visitor's own role-card fact shown above in "Your call to make". */
function filterNonDuplicateCompanyFacts<T extends { text: string }>(
  companyFacts: readonly T[],
  myRoleFacts: readonly string[],
): T[] {
  const seen = new Set<string>();
  const unique = companyFacts.filter((entry) => {
    const key = entry.text.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (myRoleFacts.length === 0) return unique;
  const roleTokens = new Set(
    myRoleFacts
      .join(' ')
      .toLowerCase()
      .replace(/,/g, '')
      .match(/[a-z0-9]{3,}/g) ?? [],
  );
  return unique.filter((entry) => {
    const clean = entry.text.toLowerCase().replace(/,/g, '');
    // If both the role card and the company record cite the same specific numbers (e.g. "35" and "1100"), it's a duplicate of their own card.
    const numbers = clean.match(/\b\d{2,}\b/g) ?? [];
    const sharedNumbers = numbers.filter((num) => roleTokens.has(num));
    if (sharedNumbers.length >= 2) return false;
    const words = (clean.match(/[a-z0-9]{4,}/g) ?? []).filter((w) => !GENERIC_WORDS.has(w));
    if (words.length === 0) return true;
    const overlap = words.filter((w) => roleTokens.has(w)).length / words.length;
    return overlap < 0.55;
  });
}
