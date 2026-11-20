import type { KakiEvent } from '@kaki/shared';

/** Who has spoken on one agenda item, as seen in a single feed. */
export interface TopicSpeech {
  /** Seats whose lines carried a speakerRole, so a renamed seat still counts as its role. */
  roles: ReadonlySet<string>;
  /** Cleaned speaker names from lines with no speakerRole, for older feeds and scripted replays. */
  names: ReadonlySet<string>;
}

export type TranscriptChunkEvent = Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }>;

/**
 * File one transcript line under the agenda item that was current when it arrived. Seats are exact;
 * a name is only a fallback for lines with no seat. Returns the same map when nothing is new.
 */
export function addTopicSpeech(
  speech: ReadonlyMap<number, TopicSpeech>,
  agendaIndex: number,
  chunk: TranscriptChunkEvent,
): ReadonlyMap<number, TopicSpeech> {
  const current = speech.get(agendaIndex);
  const speakerRole = chunk.payload.speakerRole;
  if (speakerRole !== undefined) {
    if (current?.roles.has(speakerRole) === true) return speech;
    const next = new Map(speech);
    next.set(agendaIndex, {
      roles: new Set(current?.roles ?? []).add(speakerRole),
      names: current?.names ?? new Set<string>(),
    });
    return next;
  }
  const speakerName = chunk.payload.speaker.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  if (speakerName === '' || current?.names.has(speakerName) === true) return speech;
  const next = new Map(speech);
  next.set(agendaIndex, {
    roles: current?.roles ?? new Set<string>(),
    names: new Set(current?.names ?? []).add(speakerName),
  });
  return next;
}

/**
 * Build the whole speech-by-topic map from a feed, starting from the item that was current before
 * the feed's first record. This is the same derivation the hook applies line by line.
 */
export function speechByTopicFromEvents(
  events: readonly KakiEvent[],
  initialAgendaIndex = 0,
): ReadonlyMap<number, TopicSpeech> {
  let agendaIndex = initialAgendaIndex;
  let speech: ReadonlyMap<number, TopicSpeech> = new Map();
  for (const event of events) {
    if (event.type === 'MEETING_RECORD_UPDATED') {
      agendaIndex = event.payload.agendaIndex;
    } else if (event.type === 'TRANSCRIPT_CHUNK') {
      speech = addTopicSpeech(speech, agendaIndex, event);
    }
  }
  return speech;
}
