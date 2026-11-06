import { describe, expect, it, vi } from 'vitest';
import type { Fact, KakiEvent, Scenario, SearchCompanyData } from '@kaki/shared';
import type { Hub } from '../../src/hub';
import type { TaskStore } from '../../src/tasks';
import { createKnowledgeModule } from '../../src/wingman/knowledge/module';
import { settle, waitFor } from '../helpers';

const scenario: Scenario = {
  id: 'test-kitchen',
  organisation: 'Test Kitchen',
  meetingTitle: 'Lunch service',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'game_designer', label: 'Game Designer' },
    { id: 'producer', label: 'Producer' },
  ],
  attendees: [],
  agenda: [{ title: 'Prep', minutes: 5, ownerRole: 'chef' }],
};

const fact: Fact = { text: 'Level 5 has the quit spike.', source: 'postgres', date: '2026-11-10' };

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
  questionId = 'q-quit',
  forRole: 'game_designer' | 'producer' | null = 'game_designer',
): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex: 0,
      openQuestions: [{ id: questionId, text: 'Where do players quit?', ...(forRole === null ? {} : { forRole }) }],
      elapsedSeconds: 1,
      speakerTalkSeconds: {},
    },
  };
}

function start(search: SearchCompanyData, hub: Hub): () => void {
  const module = createKnowledgeModule({ search, env: {} });
  const stop = module.start({ hub, tasks: {} as TaskStore, scenario });
  if (typeof stop !== 'function') throw new Error('Expected a cleanup function');
  return stop;
}

describe('knowledge module', () => {
  it('publishes one private card for a question, only to its role', async () => {
    const calls: string[] = [];
    const search: SearchCompanyData = async (question, role) => {
      calls.push(`${question}:${role}`);
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate());
      fake.emit(recordUpdate());
      await waitFor(() => fake.published.length > 0, 'the fact card');
      await settle();

      expect(calls).toEqual(['Where do players quit?:game_designer']);
      expect(fake.published).toEqual([
        {
          type: 'FACT_FOUND',
          audience: { kind: 'role', role: 'game_designer' },
          payload: { questionId: 'q-quit', question: 'Where do players quit?', facts: [fact] },
        },
      ]);
      expect(fake.retainKeys).toEqual(['fact:q-quit']);
    } finally {
      stop();
    }
  });

  it('skips questions without a role and warns once', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate('q-orphan', null));
      fake.emit(recordUpdate('q-orphan', null));
      await settle();
      expect(search).not.toHaveBeenCalled();
      expect(fake.published).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('q-orphan'));
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it('logs loudly and sends no card when the search fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const search: SearchCompanyData = async () => {
      throw new Error('gateway down');
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate());
      await waitFor(() => error.mock.calls.length > 0, 'the loud error');
      expect(fake.published).toEqual([]);
      expect(error.mock.calls[0]?.[0]).toContain('q-quit');
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('retries a failed search on the next record, then gives up after three tries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const search: SearchCompanyData = async () => {
      calls += 1;
      throw new Error('gateway down');
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      for (let i = 0; i < 5; i += 1) {
        fake.emit(recordUpdate());
        await settle();
      }
      expect(calls).toBe(3);
      expect(fake.published).toEqual([]);
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('sends the card once when a retry succeeds', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let calls = 0;
    const search: SearchCompanyData = async () => {
      calls += 1;
      if (calls === 1) throw new Error('gateway down');
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      for (let i = 0; i < 3; i += 1) {
        fake.emit(recordUpdate());
        await settle();
      }
      expect(calls).toBe(2);
      expect(fake.published).toHaveLength(1);
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('logs loudly and sends no card when the search finds no facts', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeHub();
    const stop = start(async () => [], fake.hub);

    try {
      fake.emit(recordUpdate());
      await waitFor(() => error.mock.calls.length > 0, 'the empty-result error');
      expect(fake.published).toEqual([]);
      expect(error.mock.calls[0]?.[0]).toContain('no company facts');
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('stays disabled and explains why when config is missing', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fake = fakeHub();
    const module = createKnowledgeModule({ env: {} });

    try {
      const stop = module.start({ hub: fake.hub, tasks: {} as TaskStore, scenario });
      expect(stop).toBeUndefined();
      expect(fake.subscribed()).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('company search disabled'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('KAKI_LLM_BASE_URL'));
    } finally {
      log.mockRestore();
    }
  });
});
