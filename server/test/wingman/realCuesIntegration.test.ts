import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultMeetingSetup,
  type KakiCommand,
  type KakiEvent,
  type MeetingPace,
  type MeetingSetup,
  type Role,
  type Scenario,
} from '@kaki/shared';
import { createMeetingModule } from '../../src/host/meeting';
import type { ClientAudience } from '../../src/core/audience';
import type { Hub } from '../../src/core/hub';
import type { KakiContext } from '../../src/core/modules';
import type { MeetingSession } from '../../src/meeting/session';
import type { TaskStore } from '../../src/meeting/tasks';
import type { SavedMeetingDetails } from '../../src/persist/state';
import { createFakeLlm } from '../../src/services/llm';
import { createWingmanModule } from '../../src/wingman/module';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type CommandHandler = (
  command: KakiCommand,
  sender: ClientAudience,
) => void | { commit(): void | Promise<void> } | Promise<void | { commit(): void | Promise<void> }>;

/** A hub that delivers each publish to every subscriber, as the real in-process hub does. */
function deliveringHub(): { hub: Hub; published: KakiEvent[] } {
  const handlers = new Set<(event: KakiEvent) => void>();
  const commandHandlers: CommandHandler[] = [];
  const published: KakiEvent[] = [];
  const hub: Hub = {
    publish(event) {
      published.push(event);
      for (const handler of [...handlers]) handler(event);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onCommand(handler) {
      commandHandlers.push(handler as CommandHandler);
    },
    clearRetained() {},
    close() {
      handlers.clear();
    },
  };
  return { hub, published };
}

const pace: MeetingPace = { quietCheckAfter: 91, comingUpBefore: 43 };

const scenario: Scenario = {
  id: 'real-cues-integration',
  organisation: 'Test Workspace',
  meetingTitle: 'Weekly planning',
  roles: [
    { id: 'host', label: 'Host', facilitator: true },
    { id: 'raj', label: 'Raj' },
    { id: 'mei', label: 'Mei' },
  ],
  attendees: [
    { name: 'Ada', role: 'host', displayName: 'Ada' },
    { name: 'Raj', role: 'raj', displayName: 'Raj' },
    { name: 'Mei', role: 'mei', displayName: 'Mei' },
  ],
  agenda: [
    { title: 'Budget', minutes: 10, canWait: false, deadline: 'today', ownerRole: 'raj' },
    { title: 'Hiring', minutes: 5, canWait: false, deadline: 'today', ownerRole: 'mei' },
  ],
};

const holders: Array<{ name: string; seat: Role; displayName: string }> = [
  { name: 'Ada', seat: 'host', displayName: 'Ada' },
  { name: 'Raj', seat: 'raj', displayName: 'Raj' },
  { name: 'Mei', seat: 'mei', displayName: 'Mei' },
];

function sealedSetup(): MeetingSetup {
  return {
    ...defaultMeetingSetup(scenario),
    pace: { ...pace },
    seats: holders.map((holder) => ({
      displayName: holder.displayName,
      roleId: holder.seat,
      kind: 'person' as const,
    })),
  };
}

function details(setup: MeetingSetup): SavedMeetingDetails {
  return {
    meetingId: 'meeting-1',
    phase: 'running',
    draft: setup,
    draftTouched: true,
    sealed: setup,
    holders: holders.map((holder) => ({ ...holder })),
    meetingCode: 'AB12CD',
  };
}

function isNote(event: KakiEvent): event is Extract<KakiEvent, { type: 'WINGMAN_NOTE' }> {
  return event.type === 'WINGMAN_NOTE';
}

function isRecord(event: KakiEvent): event is Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }> {
  return event.type === 'MEETING_RECORD_UPDATED';
}

describe('real-meeting pace cues on the live clock', () => {
  it('publishes records every tick so cues fire at the exact second, not on a heartbeat', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { hub, published } = deliveringHub();
    const setup = sealedSetup();
    const saved = details(setup);
    const llm = createFakeLlm(() =>
      JSON.stringify({ suggestion: '', basis: 'none', evidence: '', source: '' }),
    );
    const tasks = {
      list: () => [],
      onChange: () => () => undefined,
      reset: () => undefined,
    } as unknown as TaskStore;
    const ctx = {
      hub,
      tasks,
      activeScenario: () => scenario,
      meetingId: () => 'meeting-1',
      workspaceId: () => 'workspace-1',
      meetingKind: () => 'real' as const,
      meetingDetails: () => saved,
      session: {
        sealed: () => setup,
        holders: () => holders,
        offTheRecordSince: () => undefined,
      } as unknown as MeetingSession,
      seatIsGuest: () => false,
      presentRoles: () => new Set(holders.map((holder) => holder.seat)),
    } as KakiContext;

    const host = createMeetingModule({ llm, notetakerIntervalMs: 1_000_000 }).start(ctx);
    const wingman = createWingmanModule({
      llm,
      search: async () => [],
      askedCheckDelayMs: 1_000_000,
      recordRateLimitMs: 1_000_000,
    }).start(ctx);
    try {
      hub.publish({
        type: 'MEETING_STARTED',
        audience: { kind: 'all' },
        payload: { meetingId: 'meeting-1', startedAt: new Date().toISOString() },
      });

      // A second before the quiet check is due: no cue, yet the record is already current.
      await vi.advanceTimersByTimeAsync(90_000);
      expect(published.filter(isRecord).at(-1)?.payload.elapsedSeconds).toBe(90);
      expect(published.filter(isNote).filter((event) => event.payload.kind === 'lead')).toEqual([]);

      // The exact second: one lead, once.
      await vi.advanceTimersByTimeAsync(1_000);
      const leads = published.filter(isNote).filter((event) => event.payload.kind === 'lead');
      expect(leads).toHaveLength(1);
      expect(leads[0]?.audience).toEqual({ kind: 'role', role: 'host' });
      expect(leads[0]?.payload.text).toBe('Not heard from yet: Raj, Mei');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(published.filter(isNote).filter((event) => event.payload.kind === 'lead')).toHaveLength(1);

      // A second before the coming-up warning is due: no private note for Mei.
      const upcoming = (): Extract<KakiEvent, { type: 'WINGMAN_NOTE' }>[] =>
        published
          .filter(isNote)
          .filter(
            (event) => event.payload.kind === 'nudge' && event.payload.title === 'Your next item',
          );
      await vi.advanceTimersByTimeAsync(556_000 - 92_000);
      expect(published.filter(isRecord).at(-1)?.payload.elapsedSeconds).toBe(556);
      expect(upcoming()).toEqual([]);

      // The exact second: one coming-up note, once.
      await vi.advanceTimersByTimeAsync(1_000);
      const warnings = upcoming();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.audience).toEqual({ kind: 'role', role: 'mei' });
      expect(warnings[0]?.payload.text).toBe("Up next in about 1 min: Hiring, it's yours.");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(upcoming()).toHaveLength(1);
    } finally {
      if (typeof wingman === 'function') wingman();
      if (typeof host === 'function') host();
    }
  });
});
