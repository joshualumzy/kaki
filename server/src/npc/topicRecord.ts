/**
 * What the room has already said on the topic the meeting is on now, and the one question still waiting
 * for an answer. Characters see the whole topic, not only the last minute, so nobody re-says a fact or
 * reopens a point the room already heard. The prompt view stays small: the latest lines whole, older
 * ones clipped to their opening, so a long topic never crowds out the rest of the system prompt.
 */

/** The latest lines shown whole in the prompt. */
export const TOPIC_RECENT_LINES = 12;
/** How many older lines are shown, clipped to their opening words. */
export const TOPIC_EARLIER_LINES = 10;
const EARLIER_WORDS = 10;

export interface TopicLine {
  speaker: string;
  text: string;
}

/** Who asked whom, and the words of the question that is still waiting. */
export interface OpenQuestion {
  from: string;
  to: string;
  text: string;
}

export interface TopicPromptView {
  /** Lines older than the latest {@link TOPIC_RECENT_LINES}, clipped to their opening words. */
  earlier: TopicLine[];
  /** The latest lines on the topic, whole. */
  recent: TopicLine[];
  openQuestion?: OpenQuestion;
}

function firstWords(text: string, count: number): string {
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length <= count ? words.join(' ') : `${words.slice(0, count).join(' ')}…`;
}

export class TopicRecord {
  private topic: string | undefined;
  private lines: TopicLine[] = [];
  private open: OpenQuestion | undefined;

  /** Begin a new topic; a different title forgets everything said on the last one. */
  start(topic: string | undefined): void {
    if (topic === this.topic) return;
    this.topic = topic;
    this.lines = [];
    this.open = undefined;
  }

  /** Wipe the record but stay on the current topic (a meeting reset). */
  reset(): void {
    this.lines = [];
    this.open = undefined;
  }

  /** A line the room heard on this topic, in the order it was heard. */
  said(line: TopicLine): void {
    this.lines.push({ speaker: line.speaker, text: line.text });
  }

  /** A new question replaces the one before it: there is only ever one the room still has to answer. */
  ask(question: OpenQuestion): void {
    this.open = { ...question };
  }

  answered(): void {
    this.open = undefined;
  }

  get openQuestion(): OpenQuestion | undefined {
    return this.open === undefined ? undefined : { ...this.open };
  }

  promptView(): TopicPromptView {
    const recent = this.lines.slice(-TOPIC_RECENT_LINES).map((line) => ({ ...line }));
    const older = this.lines.slice(0, Math.max(0, this.lines.length - TOPIC_RECENT_LINES));
    const earlier = older.slice(-TOPIC_EARLIER_LINES).map((line) => ({
      speaker: line.speaker,
      text: firstWords(line.text, EARLIER_WORDS),
    }));
    return this.open === undefined
      ? { earlier, recent }
      : { earlier, recent, openQuestion: { ...this.open } };
  }
}
