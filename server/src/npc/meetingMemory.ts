import { MEETING_MEMORY_LIMIT, type MeetingMemoryEntry, type Scenario } from '@kaki/shared';

const NUMBER = /(?:[$£€]\s*\d+(?:[.,]\d+)?|\b\d{1,2}:\d{2}\s*(?:am|pm)?\b|\b\d+(?:[.,]\d+)?\s*%|\b\d+(?:[.,]\d+)?\b)/gi;
const tokens = (text: string): string[] => [...text.matchAll(NUMBER)].map((match) => match[0].toLowerCase().replace(/\s+/g, ''));

/** Only the text in a scenario can already be known aloud; numeric limits and flags are not things people say. */
function scenarioText(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) scenarioText(item, into);
  else if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) scenarioText(child, into);
  return into;
}

/** The facts a meeting has established, reported to the server whenever they change. */
export class MeetingMemory {
  private entries: MeetingMemoryEntry[] = [];
  private readonly reopened = new Set<string>();
  private readonly scenarioNumbers: Set<string>;

  constructor(scenario: Scenario, private readonly changed: (entries: MeetingMemoryEntry[]) => void, private readonly log: (line: string) => void) {
    this.scenarioNumbers = new Set(scenarioText(scenario).flatMap(tokens));
  }

  snapshot(): MeetingMemoryEntry[] { return this.entries.map((entry) => ({ ...entry })); }
  reopenedItems(): string[] { return [...this.reopened]; }
  wasReopened(item: string): boolean { return this.reopened.has(item); }
  markReopened(item: string): void { this.reopened.add(item); }

  replace(entries: readonly MeetingMemoryEntry[]): void {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.changed(this.snapshot());
  }

  reset(): void {
    this.entries = [];
    this.reopened.clear();
    this.changed(this.snapshot());
  }

  private add(entry: MeetingMemoryEntry): void {
    this.entries.push(entry);
    while (this.entries.length > MEETING_MEMORY_LIMIT) {
      const index = this.entries.findIndex((candidate) => candidate.kind === 'invented');
      const fallback = this.entries.findIndex((candidate) => candidate.kind === 'saidAloud');
      if (index < 0 && fallback < 0) break;
      this.entries.splice(index >= 0 ? index : fallback, 1);
    }
    this.changed(this.snapshot());
  }

  decision(item: string, text: string): void {
    this.entries = this.entries.filter((entry) => entry.kind !== 'decision' || entry.item !== item);
    this.add({ kind: 'decision', item, text });
  }

  invented(item: string, facts: readonly string[]): void {
    for (const fact of facts) {
      if (this.entries.some((entry) => entry.item === item && entry.text === fact)) continue;
      this.log(`[memory] invented ${item}: ${fact}`);
      this.add({ kind: 'invented', item, text: fact });
    }
  }

  spoken(item: string, sentence: string): void {
    const numbers = tokens(sentence);
    if (numbers.length === 0) return;
    const known = new Set([...this.scenarioNumbers, ...this.entries.flatMap((entry) => tokens(entry.text))]);
    if (numbers.every((number) => known.has(number))) return;
    const text = `said aloud: ${sentence}`;
    if (this.entries.some((entry) => entry.text === text)) return;
    this.log(`[memory] auto-added ${item}: ${text}`);
    this.add({ kind: 'saidAloud', item, text });
  }
}
