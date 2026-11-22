import { describe, expect, it } from 'vitest';
import type { KakiEvent } from '@kaki/shared';
import { roleAudience } from '../../src/core/audience';
import {
  projectedEvent,
  wantsEvent,
  wantsOwnerSeatNote,
  wantsPracticeEvent,
  wantsProjectedEvent,
} from '../../src/core/eventProjection';

const note: KakiEvent = {
  type: 'WINGMAN_NOTE',
  audience: { kind: 'role', role: 'chef' },
  payload: {
    id: 'answer:chef',
    kind: 'answer',
    urgency: 'quiet',
    title: 'Wingman',
    text: 'A private answer.',
  },
};

describe('Wingman note projection', () => {
  it('goes only to the person it is for, never to the shared screen or another seat', () => {
    expect(wantsEvent(note, { kind: 'screen' })).toBe(false);
    expect(wantsEvent(note, roleAudience('chef'))).toBe(true);
    expect(wantsEvent(note, roleAudience('cashier'))).toBe(false);

    expect(wantsProjectedEvent(note, 'chef')).toBe(true);
    expect(wantsProjectedEvent(note, 'cashier')).toBe(false);
    expect(wantsProjectedEvent(note, undefined)).toBe(false);

    expect(projectedEvent(note, 'chef', false)).toBe(note);
    expect(projectedEvent(note, 'cashier', false)).toBe(note);
    expect(projectedEvent(note, 'chef', true)).toBe(note);
    expect(projectedEvent(note, 'cashier', true)).toBeUndefined();
  });

  it('reaches a practice screen only for its own seat', () => {
    expect(wantsPracticeEvent(note, 'chef')).toBe(true);
    expect(wantsPracticeEvent(note, 'cashier')).toBe(false);
    expect(wantsPracticeEvent(note, undefined)).toBe(false);
  });

  it('never lets the owner screen see a private note meant for a seat', () => {
    expect(wantsEvent(note, { kind: 'screen' })).toBe(false);
  });

  it('reaches an owner screen only for the seat that owner holds', () => {
    expect(wantsOwnerSeatNote(note, 'chef')).toBe(true);
    expect(wantsOwnerSeatNote(note, 'cashier')).toBe(false);
    expect(wantsOwnerSeatNote(note, undefined)).toBe(false);
  });
});
