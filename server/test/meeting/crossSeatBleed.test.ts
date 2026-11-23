import { describe, expect, it } from 'vitest';
import {
  CROSS_SEAT_BLEED_RETENTION_MS,
  findCrossSeatDuplicate,
  rememberSpeechLine,
  type SpeechLine,
} from '../../src/meeting/crossSeatBleed';

function line(overrides: Partial<SpeechLine> = {}): SpeechLine {
  return {
    seat: 'seat-a',
    speaker: 'Ada',
    text: 'We open at eight.',
    speechStartedAt: 1_000,
    speechEndedAt: 2_000,
    micLevel: 0.12,
    ...overrides,
  };
}

describe('cross-seat speech bleed', () => {
  it('drops a quieter copy whose speech time overlaps the original seat', () => {
    const duplicate = findCrossSeatDuplicate(
      line({ seat: 'seat-b', speaker: 'Bao', text: '  we   OPEN at eight. ', speechStartedAt: 1_100, speechEndedAt: 2_100, micLevel: 0.03 }),
      [line()],
    );
    expect(duplicate).toMatchObject({ seat: 'seat-a', speaker: 'Ada' });
  });

  it('keeps two people who both say "Yes" at separate times', () => {
    expect(
      findCrossSeatDuplicate(
        line({ seat: 'seat-b', speaker: 'Bao', text: 'Yes', speechStartedAt: 4_000, speechEndedAt: 4_500, micLevel: 0.03 }),
        [line({ text: 'Yes', speechStartedAt: 1_000, speechEndedAt: 1_500 })],
      ),
    ).toBeUndefined();
  });

  it('keeps two people who both say "Yes" over the same time at similar levels', () => {
    expect(
      findCrossSeatDuplicate(
        line({ seat: 'seat-b', speaker: 'Bao', text: 'Yes', speechStartedAt: 1_100, speechEndedAt: 1_600, micLevel: 0.1 }),
        [line({ text: 'Yes', speechStartedAt: 1_000, speechEndedAt: 1_500, micLevel: 0.11 })],
      ),
    ).toBeUndefined();
  });

  it('keeps a softer real voice: half as loud is two people, not bleed', () => {
    expect(
      findCrossSeatDuplicate(
        line({ seat: 'seat-b', speaker: 'Bao', text: 'Yes', speechStartedAt: 1_100, speechEndedAt: 1_600, micLevel: 0.06 }),
        [line({ text: 'Yes', speechStartedAt: 1_000, speechEndedAt: 1_500, micLevel: 0.12 })],
      ),
    ).toBeUndefined();
  });

  it('keeps the same seat repeating its own line', () => {
    expect(
      findCrossSeatDuplicate(line({ speechStartedAt: 1_100, speechEndedAt: 2_100, micLevel: 0.03 }), [line()]),
    ).toBeUndefined();
  });

  it('never drops a line without both speech timing and a measured microphone level', () => {
    expect(
      findCrossSeatDuplicate(
        line({ seat: 'seat-b', micLevel: undefined, speechStartedAt: 1_100, speechEndedAt: 2_100 }),
        [line()],
      ),
    ).toBeUndefined();
    expect(
      findCrossSeatDuplicate(
        line({ seat: 'seat-b', micLevel: 0.03, speechStartedAt: undefined, speechEndedAt: undefined }),
        [line()],
      ),
    ).toBeUndefined();
    expect(
      findCrossSeatDuplicate(line({ seat: 'seat-b', micLevel: 0.03, speechStartedAt: 1_100 }), [
        line({ micLevel: undefined }),
      ]),
    ).toBeUndefined();
  });

  it('never matches a different line', () => {
    expect(
      findCrossSeatDuplicate(line({ seat: 'seat-b', text: 'The till is short.', micLevel: 0.03 }), [line()]),
    ).toBeUndefined();
  });

  it('keeps recent lines only for as long as a copy could still arrive', () => {
    const recent: SpeechLine[] = [];
    rememberSpeechLine(recent, line());
    expect(recent).toHaveLength(1);
    rememberSpeechLine(
      recent,
      line({ seat: 'seat-b', text: 'A later line.', speechStartedAt: 2_000 + CROSS_SEAT_BLEED_RETENTION_MS, speechEndedAt: 3_000 + CROSS_SEAT_BLEED_RETENTION_MS }),
    );
    expect(recent.map((entry) => entry.text)).toEqual(['A later line.']);
  });
});
