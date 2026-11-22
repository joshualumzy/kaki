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

/**
 * Compact context card for the current agenda item: its owner and the two sides the room has
 * actually raised. Private Wingman notes live in their own panel, never on this shared card.
 */
export function CurrentTopicCard({
  item,
  scenario,
  role,
  viewer,
  events,
  agendaIndex,
}: {
  item: AgendaItem | undefined;
  scenario: Scenario;
  role: ScenarioRole | undefined;
  viewer: TranscriptViewer;
  events?: readonly KakiEvent[];
  agendaIndex?: number;
}) {
  if (item === undefined) return null;
  const isMyItem = role !== undefined && item.ownerRole === role.id;
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

  // Until the room has raised a catch, keep the card out of the way: it has nothing to say.
  if (visibleTradeOffs.length === 0) return null;

  return (
    <section className="kd-role kd-topic-card" aria-label="Current topic context">
      <p className="kd-role-eyebrow">Current topic · {roleBadge}</p>
      <ul className="kd-record-list" style={{ marginBottom: 0, marginTop: 6 }}>
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
    </section>
  );
}
