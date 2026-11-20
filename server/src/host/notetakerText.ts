import { roleLabel, type Scenario } from '@kaki/shared';
import type { SavedTranscriptLine } from '../persist/state';

/** Rough speaking rate used to turn transcript words into talk time. */
const WORDS_PER_SECOND = 2.5;
// Words that say nothing about which task it is, ignored when comparing task titles.
export const FILLER_WORDS = new Set(
  (
    'a an and at by for from in into of on or the to with after before about once our their this that ' +
    'fix file send post email create add make update write draft ask get do check confirm follow up ' +
    'decision team channel today tomorrow everyone use'
  ).split(' '),
);

// Words that start or pad almost any question ("is it", "do we know"), ignored when comparing questions. Without
// them a short question like "Is it the timer?" looks like a repeat of any long question containing "is it".
export const QUESTION_WORDS = new Set(
  (
    'is it are was were be do does did we you they he she i there here what when where which who why how can could ' +
    'will would should have has had know any if so then than not no yes'
  ).split(' '),
);
export type TranscriptLine = SavedTranscriptLine;
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}
// The words that identify a task, roughly singularised so "customers" matches "customer".
export function keywords(text: string, ignore: Set<string> = FILLER_WORDS): Set<string> {
  return new Set(
    words(text)
      .filter((word) => !ignore.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word)),
  );
}
export function estimateTalkSeconds(text: string): number {
  return Math.max(1, words(text).length / WORDS_PER_SECOND);
}
function speakerLabel(line: TranscriptLine, scenario: Scenario): string {
  return line.role === undefined ? line.speaker : `${line.speaker} (${roleLabel(scenario, line.role)})`;
}
/** One prompt line; an overlap marker tells the model the two people spoke at the same time. */
export function transcriptLineText(line: TranscriptLine, scenario: Scenario): string {
  const overlap = line.overlap === true ? ', overlapping speech' : '';
  return `[${speakerLabel(line, scenario)}${overlap}] ${line.text}`;
}
