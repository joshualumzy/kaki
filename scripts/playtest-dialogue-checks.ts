/** Pure dialogue and Wingman checks for scripts/playtest-dialogue.ts. */
import { catchPosition, type AgendaItem } from '@kaki/shared';
import { spokenTopicLead } from '../server/src/host/opening';

export interface UtteranceRecord {
  speaker: string;
  text: string;
  /** Set on the last sentence of a colleague line that raises a scenario catch. */
  catchId?: string;
}

interface VisitorSeat {
  name: string;
  role: string;
  /** The scenario seat the visitor took, when it differs from the name typed at join. */
  seat?: string;
}

export interface WingmanTip {
  tip: string;
  title: string;
  agendaIndex: number;
}

export interface EmittedCatch {
  speaker: string;
  text: string;
  catchId: string;
}

// Helpers for quality checks
const BANNED_PATTERNS = [
  { re: /\bthe catch on our side\b/i, reason: 'Used banned cliché "the catch on our side"' },
  { re: /\bour tiktok reviewer\b/i, reason: 'Referred to reviewer as "our TikTok reviewer"' },
  { re: /\bwith 85,?000 followers\b/i, reason: 'Recited verbatim press-release follower count' },
  { re: /\bhere from [A-Z][a-z]+ (?:Lead|Director|Manager)\b/i, reason: 'Awkward grammar "here from <Title>"' },
  { re: /^(?:(?:hey|hi|hello)\s+[a-z]+,\s*)?(?:and\s+)?(?:mei|arjun|daniel|wei ling)\s+from\s+[a-z]+,/i, reason: 'Broken comma-splice roll-call intro ("<Name> from <dept>, ...")' },
  { re: /\bban(?:ning)? (?:laptop users|window stools)\b/i, reason: 'Argued against a phantom ban on laptop users nobody proposed' },
  { re: /\bpulling (?:our )?counter staff off the line to hand-deliver\b/i, reason: 'Argued against a phantom proposal to pull counter staff to hand-deliver' },
];

export function checkTranscriptQuality(
  item: AgendaItem,
  transcript: UtteranceRecord[],
  human: VisitorSeat,
  hostName = 'Sam',
): string[] {
  const failures: string[] = [];
  if (transcript.length === 0) {
    return ['No transcript utterances were produced'];
  }

  // 1. Check for banned phrases
  for (const turn of transcript) {
    for (const { re, reason } of BANNED_PATTERNS) {
      if (re.test(turn.text)) {
        failures.push(`${turn.speaker}: ${reason} -> "${turn.text}"`);
      }
    }

    // Sentence length check (pacing)
    const sentences = turn.text.split(/(?<=[.?!])\s+/);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length > 32) {
        failures.push(`${turn.speaker}: Sentence too long (${words.length} words, max 32) -> "${sentence}"`);
      }
    }
  }

  // 2. Identify Host, Speaker 1, and Speaker 2
  const hostLine = transcript.find((t) => t.speaker === hostName);
  const nonHost = transcript.filter((t) => t.speaker !== hostName && t.speaker !== human.name);
  const speaker1 = nonHost[0];
  const speaker2 = nonHost.find((t) => t.speaker !== speaker1?.speaker);

  // 3. The briefing needs every expected turn: the host opener and two colleagues.
  if (hostLine === undefined) {
    failures.push(`${hostName} (Host): never opened the agenda item`);
  } else if (hostLine.text.includes(item.title) && !hostLine.text.includes(spokenTopicLead(item.title))) {
    failures.push(`${hostName}: Recited raw agenda title "${item.title}" instead of natural spoken lead`);
  }

  // 4. Speaker 1 check
  if (speaker1) {
    // Speaker 1 should not lead with isolated budget numbers in the very first sentence
    const firstSentence = speaker1.text.split(/(?<=[.?!])\s+/)[0] ?? '';
    if (/^\s*(?:our launch budget|we only have \$\d+|\$\d+ left)\b/i.test(firstSentence)) {
      failures.push(`${speaker1.speaker} (Speaker 1): Inverted order! Led with budget before ground trigger -> "${firstSentence}"`);
    }
  } else {
    failures.push('Speaker 1 never spoke');
  }

  // 5. Speaker 2 check (Causal link & Question)
  if (speaker2) {
    const allSpeaker2Text = nonHost.filter((t) => t.speaker === speaker2.speaker).map((t) => t.text).join(' ');
    // Must end with question addressed to human
    const hasQuestion = /\?/.test(allSpeaker2Text);
    const namesHuman = new RegExp(`\\b${human.name}\\b`, 'i').test(allSpeaker2Text);
    if (!hasQuestion) {
      failures.push(`${speaker2.speaker} (Speaker 2): Failed to ask a question to wrap up the briefing`);
    }
    if (!namesHuman) {
      failures.push(`${speaker2.speaker} (Speaker 2): Did not address visitor (${human.name}) by name`);
    }

    // Topic-specific causal diagnostic checks
    if (item.title.includes('Food safety')) {
      if (!/fridge|disposal|officer|delivery|review|eggs|kaya/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the fridge, the disposal log or the officer visit`);
      }
    } else if (item.title.includes('Delivery')) {
      if (!/grabfood|platter|pickup|commission|margin|tray/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the commission, platter or pickup margin`);
      }
    } else if (item.title.includes('Laptop')) {
      if (!/solo|tray|stool|socket|wifi|code|timer/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the solo diners, stools or socket timer`);
      }
    } else if (item.title.includes('regulars')) {
      if (!/price|kopi|till|facebook|share|note/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the old price, the till button or the public post`);
      }
    } else if (item.title.includes('counter staff')) {
      if (!/rest day|double pay|login|temp|manager|toast|kiosk/i.test(allSpeaker2Text)) {
        failures.push(`${speaker2.speaker}: Missing causal link! Did not explain the counter cover options`);
      }
    }
  } else {
    failures.push('Speaker 2 never spoke');
  }

  return failures;
}

/** True when a trade-off belongs to the visitor's own seat, which the Wingman must never show back to them. */
export function isVisitorTradeOff(
  tradeOff: { attendee: string; role: string },
  visitor: VisitorSeat,
): boolean {
  const attendee = tradeOff.attendee.toLowerCase();
  return tradeOff.role === visitor.role ||
    attendee === visitor.name.toLowerCase() ||
    (visitor.seat !== undefined && attendee === visitor.seat.toLowerCase());
}

/**
 * Check the Wingman output the room actually emitted for this topic: raised catches must name a real
 * scenario trade-off, must belong to this topic, and must never expose the visitor's own seat.
 */
export function checkWingmanOutput(
  item: AgendaItem,
  agendaIndex: number,
  visitor: VisitorSeat,
  tips: readonly WingmanTip[],
  catches: readonly EmittedCatch[],
): string[] {
  const failures: string[] = [];
  const tradeOffs = item.discussion?.tradeOffs ?? [];
  if (tradeOffs.length === 0) return ['No tradeOffs defined in scenario'];

  if (tips.length === 0 && catches.length === 0) {
    failures.push('No Wingman output was emitted for this topic (no live tip and no raised catch), so seat exclusion was not exercised');
  }

  for (const tip of tips) {
    if (tip.tip.trim() === '') failures.push('Wingman emitted an empty live tip');
    if (tip.agendaIndex !== agendaIndex || tip.title !== item.title) {
      failures.push(`Wingman live tip was for "${tip.title}" (item ${tip.agendaIndex + 1}), not "${item.title}" (item ${agendaIndex + 1})`);
    }
  }

  for (const emitted of catches) {
    const position = catchPosition(emitted.catchId);
    if (position === undefined) {
      failures.push(`Wingman catch "${emitted.text}" has an unusable catch id "${emitted.catchId}"`);
      continue;
    }
    if (position.agendaIndex !== agendaIndex) {
      failures.push(`Wingman catch "${emitted.text}" belongs to item ${position.agendaIndex + 1}, not ${agendaIndex + 1}`);
      continue;
    }
    const tradeOff = tradeOffs[position.tradeOffIndex];
    if (tradeOff === undefined) {
      failures.push(`Wingman catch "${emitted.text}" names trade-off ${position.tradeOffIndex}, which does not exist`);
      continue;
    }
    if (isVisitorTradeOff(tradeOff, visitor)) {
      failures.push(`Wingman exposed the visitor's own seat (${tradeOff.attendee}) catch: "${emitted.text}"`);
    }
  }

  return failures;
}
