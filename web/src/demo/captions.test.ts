import { describe, expect, it } from 'vitest';
import type { KakiEvent, Scenario } from '@kaki/shared';
import { captionFor, TEXT_ONLY_NOTE, textOnlyNote, transcriptChunks, transcriptNameFor } from './captions';

const scenario: Scenario = {
  id: 's',
  organisation: 'Org',
  meetingTitle: 'Meeting',
  roles: [
    { id: 'producer', label: 'Producer' },
    { id: 'lead', label: 'Lead Programmer' },
  ],
  attendees: [
    { name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling (Producer)' },
    { name: 'Arjun', role: 'lead', zoomDisplayName: 'Arjun (Lead)' },
  ],
  agenda: [{ title: 'Build', minutes: 5, ownerRole: 'lead' }],
  npcs: [{ attendee: 'Arjun', voice: 'v', personality: 'p', agenda: 'a', concerns: ['c'] }],
};

const NOW = Date.parse('2026-01-01T10:00:30Z');
const chunk = (speaker: string, text: string, secondsAgo: number, textOnly = false): KakiEvent => ({
  type: 'TRANSCRIPT_CHUNK',
  audience: { kind: 'all' },
  payload: {
    speaker,
    text,
    timestamp: new Date(NOW - secondsAgo * 1000).toISOString(),
    ...(textOnly ? { textOnly: true } : {}),
  },
});

describe('transcriptNameFor', () => {
  it('uses the attendee display name for an AI attendee and for a visitor by chosen role', () => {
    expect(transcriptNameFor(scenario, { identity: 'Arjun', metadata: 'AI attendee' })).toBe('Arjun (Lead)');
    expect(transcriptNameFor(scenario, { identity: 'Josh', metadata: 'Producer' })).toBe('Wei Ling (Producer)');
  });

  it('falls back to the identity when the role maps to nobody', () => {
    expect(transcriptNameFor(scenario, { identity: 'Josh', metadata: 'Lead Programmer' })).toBe('Josh');
    expect(transcriptNameFor(scenario, { identity: 'Josh' })).toBe('Josh');
  });
});

describe('captionFor', () => {
  it("shows the speaker's latest line, and only theirs", () => {
    const events = transcriptChunks([chunk('Arjun (Lead)', 'First.', 3), chunk('Wei Ling (Producer)', 'Hi.', 2)]);
    expect(captionFor(events, 'Arjun (Lead)', NOW)).toBe('First.');
    expect(captionFor(events, 'wei ling (producer)', NOW)).toBe('Hi.');
    expect(captionFor(events, 'Mei', NOW)).toBeNull();
  });

  it('shows only the latest sentence one at a time, replacing earlier sentences', () => {
    const events = transcriptChunks([
      chunk('A', 'Old remark.', 25),
      chunk('A', 'One.', 7),
      chunk('A', 'Two.', 5),
      chunk('A', 'Three.', 3),
      chunk('A', 'Four.', 1),
    ]);
    expect(captionFor(events, 'A', NOW)).toBe('Four.');
  });

  it('hides a caption once it is older than the window unless the speaker is still talking', () => {
    const events = transcriptChunks([chunk('A', 'Hello.', 9)]);
    expect(captionFor(events, 'A', NOW)).toBeNull();
    expect(captionFor(events, 'A', NOW, 10_000)).toBe('Hello.');
    expect(captionFor(events, 'A', NOW, 8_000, true)).toBe('Hello.');
  });

  it('ignores blank text and unreadable timestamps', () => {
    expect(captionFor(transcriptChunks([chunk('A', '  ', 1)]), 'A', NOW)).toBeNull();
    const broken = chunk('A', 'x', 1);
    if (broken.type === 'TRANSCRIPT_CHUNK') broken.payload.timestamp = 'not a date';
    expect(captionFor(transcriptChunks([broken]), 'A', NOW)).toBeNull();
  });

  it('shows the exact spoken sentence currently playing so captions stay synced with audio', () => {
    const longSentence =
      'Hey Foo, I am Arjun, Tech and POS Lead, and our Raffles Place kiosks only take PayNow and cards right now.';
    const startChunk = chunk('A', longSentence, 0);
    expect(captionFor(transcriptChunks([startChunk]), 'A', NOW, 8000, true)).toBe(longSentence);
    expect(captionFor(transcriptChunks([startChunk]), 'A', NOW + 4000, 8000, true)).toBe(longSentence);
  });
});

describe('textOnlyNote', () => {
  it('shows the calm note while the latest line is text-only', () => {
    const events = transcriptChunks([chunk('A', 'Shown as text.', 2, true)]);
    expect(textOnlyNote(events, NOW)).toBe(TEXT_ONLY_NOTE);
  });

  it('clears as soon as a line with audio arrives', () => {
    const events = transcriptChunks([
      chunk('A', 'Shown as text.', 3, true),
      chunk('A', 'Spoken again.', 1),
    ]);
    expect(textOnlyNote(events, NOW)).toBeNull();
  });

  it('clears after ten seconds with no further text-only line', () => {
    const events = transcriptChunks([chunk('A', 'Shown as text.', 2, true)]);
    expect(textOnlyNote(events, NOW + 8_000)).toBe(TEXT_ONLY_NOTE);
    expect(textOnlyNote(events, NOW + 11_000)).toBeNull();
  });
});

describe('transcriptChunks', () => {
  it('keeps only transcript lines, newest last, capped', () => {
    const events: KakiEvent[] = [
      chunk('A', '1', 5),
      { type: 'HOST_SPEECH_TRIGGERED', audience: { kind: 'screen' }, payload: { kind: 'OPENING', text: 'hi' } },
      chunk('A', '2', 4),
      chunk('A', '3', 3),
    ];
    expect(transcriptChunks(events, 2).map((c) => c.payload.text)).toEqual(['2', '3']);
  });
});

describe('speakerLabel', () => {
  it('shows the visitor their own name for the seat they took, and leaves everyone else alone', async () => {
    const { speakerLabel } = await import('./captions');
    const viewer = { name: 'Joshua', seatName: 'Wei Ling' };
    expect(speakerLabel('Wei Ling', viewer)).toBe('Joshua (you)');
    expect(speakerLabel('wei ling', viewer)).toBe('Joshua (you)');
    expect(speakerLabel('Arjun', viewer)).toBe('Arjun');
    expect(speakerLabel('Wei Ling', undefined)).toBe('Wei Ling');
    expect(speakerLabel('Arjun', viewer, scenario)).toBe('Arjun · Lead Programmer');
    expect(speakerLabel('Wei Ling', viewer, scenario)).toBe('Joshua (you) · Producer');
  });
});
