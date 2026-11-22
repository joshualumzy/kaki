/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DisconnectReason } from 'livekit-client';
import {
  disconnectOutcome,
  clearAllStoredJoins,
  clearStoredJoin,
  formatGraceRemaining,
  readStoredJoin,
  storeJoin,
} from './rejoinSession';

beforeEach(() => {
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('remembered meeting joins', () => {
  it('keeps each journey separately so a reload can return to the same seat', () => {
    storeJoin('participant', {
      name: 'Ana',
      role: 'operations_director',
      media: { microphone: false, camera: false },
      meetingCode: 'K7QX',
    });
    storeJoin('practice', {
      name: 'Visitor',
      role: 'menu_store_lead',
      media: { microphone: true, camera: false },
    });

    expect(readStoredJoin('participant')).toEqual({
      name: 'Ana',
      role: 'operations_director',
      media: { microphone: false, camera: false },
      meetingCode: 'K7QX',
    });
    expect(readStoredJoin('practice')).toEqual({
      name: 'Visitor',
      role: 'menu_store_lead',
      media: { microphone: true, camera: false },
    });
  });

  it('ignores a damaged or incomplete entry instead of failing the join page', () => {
    window.sessionStorage.setItem('kaki.join.participant', '{not json');
    expect(readStoredJoin('participant')).toBeUndefined();

    window.sessionStorage.setItem(
      'kaki.join.participant',
      JSON.stringify({ name: 'Ana', role: 'operations_director', media: { microphone: 'yes' } }),
    );
    expect(readStoredJoin('participant')).toBeUndefined();
  });

  it('forgets one journey, or every journey when the person starts over', () => {
    storeJoin('participant', { name: 'Ana', role: 'operations_director', media: { microphone: false, camera: false } });
    storeJoin('owner', { name: 'Owner', role: 'host', media: { microphone: false, camera: false } });

    clearStoredJoin('participant');
    expect(readStoredJoin('participant')).toBeUndefined();
    expect(readStoredJoin('owner')).toBeDefined();

    clearAllStoredJoins();
    expect(readStoredJoin('owner')).toBeUndefined();
  });

  it('counts the empty-room hold down as a short clock', () => {
    expect(formatGraceRemaining(120_000)).toBe('2:00');
    expect(formatGraceRemaining(107_001)).toBe('1:48');
    expect(formatGraceRemaining(0)).toBe('0:00');
    expect(formatGraceRemaining(-5_000)).toBe('0:00');
  });
});

describe('disconnectOutcome', () => {
  it('rejoins only when the connection dropped by itself', () => {
    expect(disconnectOutcome(undefined)).toEqual({ kind: 'rejoin' });
    expect(disconnectOutcome(DisconnectReason.SIGNAL_CLOSE)).toEqual({ kind: 'rejoin' });
    expect(disconnectOutcome(DisconnectReason.UNKNOWN_REASON)).toEqual({ kind: 'rejoin' });
  });

  it('does nothing for a disconnect the page caused itself', () => {
    expect(disconnectOutcome(DisconnectReason.CLIENT_INITIATED)).toEqual({ kind: 'none' });
  });

  it('ends with an explanation when the server closed, replaced or moved the seat', () => {
    for (const reason of [DisconnectReason.DUPLICATE_IDENTITY, DisconnectReason.PARTICIPANT_REMOVED, DisconnectReason.ROOM_DELETED]) {
      const outcome = disconnectOutcome(reason);
      expect(outcome.kind).toBe('ended');
    }
  });
});
