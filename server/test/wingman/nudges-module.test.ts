import { describe, expect, it, vi } from 'vitest';
import type { Fact, KakiEvent, Role, Scenario, SearchCompanyData } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import type { TaskStore } from '../../src/tasks';
import { createNudgeModule } from '../../src/wingman/nudges/module';
import { settle, waitFor } from '../helpers';

const scenario: Scenario = {
  id: 'test-kitchen',
  organisation: 'Test Kitchen',
  meetingTitle: 'Lunch service',
  roles: [
    { id: 'lead_programmer', label: 'Lead Programmer' },
    { id: 'game_designer', label: 'Game Designer' },
    { id: 'producer', label: 'Producer' },
    { id: 'marketing_lead', label: 'Marketing Lead' },
  ],
  attendees: [],
  agenda: [
    { title: 'Build and bugs', minutes: 10, ownerRole: 'lead_programmer' },
    { title: 'Level 5 difficulty and playtest feedback', minutes: 10, ownerRole: 'game_designer' },
    { title: 'Publisher milestone', minutes: 8, ownerRole: 'producer' },
  ],
};

const fact: Fact = {
  text: 'Playtests: 14 of 20 players quit at Level 5.',
  source: 'postgres',
  date: '2026-11-10',
};

const comment = 'Tap the fact card to read the details.';

function fakeHub(): {
  hub: Hub;
  published: KakiEvent[];
  retainKeys: (string | undefined)[];
  subscribed: () => number;
  emit: (event: KakiEvent) => void;
} {
  const handlers = new Set<(event: KakiEvent) => void>();
  const published: KakiEvent[] = [];
  const retainKeys: (string | undefined)[] = [];
  const hub: Hub = {
    publish(event, options) {
      published.push(event);
      retainKeys.push(options?.retainKey);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onCommand() {
      throw new Error('not used');
    },
    clearRetained() {},
    close() {
      handlers.clear();
    },
  };
  return {
    hub,
    published,
    retainKeys,
    subscribed: () => handlers.size,
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
  };
}

function recordUpdate(
  agendaIndex: number,
  elapsedSeconds: number,
  talk: Partial<Record<Role, number>> = {},
): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: { agendaIndex, elapsedSeconds, speakerTalkSeconds: talk, openQuestions: [] },
  };
}

function start(search: SearchCompanyData, hub: Hub): () => void {
  const module = createNudgeModule({ search, env: {} });
  const stop = module.start({ hub, tasks: {} as TaskStore, scenario });
  if (typeof stop !== 'function') throw new Error('Expected a cleanup function');
  return stop;
}

function nudges(published: KakiEvent[]): KakiEvent[] {
  return published.filter((event) => event.type === 'NUDGE');
}

describe('nudge module', () => {
  it('fires one coming-up nudge at 60 seconds before, not earlier', async () => {
    const calls: string[] = [];
    const search: SearchCompanyData = async (question, role) => {
      calls.push(`${question}:${role}`);
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate(0, 539, { lead_programmer: 300 }));
      await settle(20);
      expect(nudges(fake.published)).toEqual([]);

      fake.emit(recordUpdate(0, 540, { lead_programmer: 300 }));
      await waitFor(() => nudges(fake.published).length > 0, 'the coming-up nudge');

      fake.emit(recordUpdate(0, 540, { lead_programmer: 300 }));
      await settle();
      expect(nudges(fake.published)).toHaveLength(1);
      expect(calls).toEqual(['Level 5 difficulty and playtest feedback:game_designer']);
      expect(fake.retainKeys).toEqual(['nudge:coming_up:1']);
      expect(nudges(fake.published)[0]).toEqual({
        type: 'NUDGE',
        audience: { kind: 'role', role: 'game_designer' },
        payload: {
          text: `Level 5 difficulty and playtest feedback starts in 1 min. ${fact.text} ${comment}`,
          agendaIndex: 1,
        },
      });
    } finally {
      stop();
    }
  });

  it('counts time from the start of the current item, not the meeting', async () => {
    const fake = fakeHub();
    const stop = start(async () => [fact], fake.hub);

    try {
      // Item 1 is 10 minutes long; elapsedSeconds restarts at 0 for each item.
      fake.emit(recordUpdate(1, 539, { game_designer: 300 }));
      await settle(20);
      expect(nudges(fake.published)).toEqual([]);

      fake.emit(recordUpdate(1, 540, { game_designer: 300 }));
      await waitFor(() => nudges(fake.published).length > 0, 'the coming-up nudge');
      expect(nudges(fake.published)[0]).toMatchObject({
        audience: { kind: 'role', role: 'producer' },
        payload: { text: expect.stringContaining('Publisher milestone starts in 1 min.'), agendaIndex: 2 },
      });
      expect(fake.retainKeys).toEqual(['nudge:coming_up:2']);
    } finally {
      stop();
    }
  });

  it('fires one quiet-owner nudge once the item has run 120 seconds', async () => {
    const fake = fakeHub();
    const stop = start(async () => [fact], fake.hub);

    try {
      fake.emit(recordUpdate(0, 119, { lead_programmer: 5 }));
      await settle(20);
      expect(nudges(fake.published)).toEqual([]);

      fake.emit(recordUpdate(0, 120, { lead_programmer: 5 }));
      await waitFor(() => nudges(fake.published).length > 0, 'the quiet-owner nudge');

      fake.emit(recordUpdate(0, 120, { lead_programmer: 5 }));
      await settle();
      expect(nudges(fake.published)).toHaveLength(1);
      expect(nudges(fake.published)[0]).toEqual({
        type: 'NUDGE',
        audience: { kind: 'role', role: 'lead_programmer' },
        payload: {
          text: `Build and bugs has 8 min left. ${fact.text} ${comment}`,
          agendaIndex: 0,
        },
      });
    } finally {
      stop();
    }
  });

  it('does not nudge a talkative owner', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate(0, 200, { lead_programmer: 30 }));
      await settle();
      expect(nudges(fake.published)).toEqual([]);
      expect(search).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('still sends a nudge when the search fails, and logs loudly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search: SearchCompanyData = async () => {
      throw new Error('gateway down');
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate(0, 120, { lead_programmer: 5 }));
      await waitFor(() => nudges(fake.published).length > 0, 'the fallback nudge');

      const nudge = nudges(fake.published)[0];
      expect(nudge).toBeDefined();
      if (nudge?.type !== 'NUDGE') throw new Error('Expected a nudge');
      expect(nudge.payload.text).toContain('Build and bugs');
      expect(nudge.payload.text).toContain('8 min left');
      expect(nudge.payload.text).toContain('No company records were found');
      expect(error).toHaveBeenCalled();
      expect(error.mock.calls[0]?.[0]).toContain('company search failed');
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('sends the nudge only to the owner role', async () => {
    const fake = fakeHub();
    const stop = start(async () => [fact], fake.hub);

    try {
      fake.emit(recordUpdate(0, 540, { lead_programmer: 300 }));
      await waitFor(() => nudges(fake.published).length > 0, 'the coming-up nudge');

      expect(fake.published).toEqual([
        expect.objectContaining({ audience: { kind: 'role', role: 'game_designer' } }),
      ]);
    } finally {
      stop();
    }
  });

  it('skips the coming-up nudge when the next item has the same owner', async () => {
    const fake = fakeHub();
    const module = createNudgeModule({ search: async () => [fact], env: {} });
    const sameOwner: Scenario = {
      ...scenario,
      agenda: [
        { title: 'Build and bugs', minutes: 10, ownerRole: 'lead_programmer' },
        { title: 'Level 5 difficulty and playtest feedback', minutes: 10, ownerRole: 'lead_programmer' },
      ],
    };
    const stop = module.start({ hub: fake.hub, tasks: {} as TaskStore, scenario: sameOwner });

    try {
      if (typeof stop !== 'function') throw new Error('Expected a cleanup function');
      fake.emit(recordUpdate(0, 540, { lead_programmer: 300 }));
      await settle();
      expect(nudges(fake.published)).toEqual([]);
    } finally {
      if (typeof stop === 'function') stop();
    }
  });

  it('stays disabled and explains why when config is missing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = fakeHub();
    const module = createNudgeModule({ env: {} });

    try {
      const stop = module.start({ hub: fake.hub, tasks: {} as TaskStore, scenario });
      expect(stop).toBeUndefined();
      expect(fake.subscribed()).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('nudges disabled'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('KAKI_LLM_BASE_URL'));
    } finally {
      log.mockRestore();
    }
  });
});
