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
  agenda: [
    { title: 'Prep', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef', decision: 'Do we prep early?' },
    { title: 'Stock', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier', decision: 'How much stock?' },
  ],
};

const wingmanScenario: Scenario = {
  id: 'test-wingman',
  organisation: 'Test Kitchen',
  meetingTitle: 'Lunch service',
  roles: [
    { id: 'chef', label: 'Chef' },
    { id: 'cashier', label: 'Cashier' },
    { id: 'host', label: 'Host', facilitator: true },
  ],
  attendees: [
    { name: 'Ada', role: 'chef', zoomDisplayName: 'Ada' },
    { name: 'Bao', role: 'cashier', zoomDisplayName: 'Bao' },
    { name: 'Sam', role: 'host', zoomDisplayName: 'Sam' },
  ],
  agenda: [
    { title: 'Prep', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'chef', decision: 'Do we prep early?' },
    { title: 'Stock', minutes: 5, canWait: false, deadline: 'before doors open at 8', ownerRole: 'cashier', decision: 'How much stock?' },
  ],
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
  agendaIndex = 0,
  questionAgendaIndex = agendaIndex,
): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex,
      openQuestions: [
        {
          id: questionId,
          text: 'Where do players quit?',
          agendaIndex: questionAgendaIndex,
          ...(forRole === null ? {} : { forRole }),
        },
      ],
      elapsedSeconds: 1,
      speakerTalkSeconds: {},
    },
  };
}

function recordUpdateWithNoQuestions(agendaIndex = 0): KakiEvent {
  return {
    type: 'MEETING_RECORD_UPDATED',
    audience: { kind: 'all' },
    payload: {
      agendaIndex,
      openQuestions: [],
      elapsedSeconds: 1,
      speakerTalkSeconds: {},
    },
  };
}

function start(
  search: SearchCompanyData,
  hub: Hub,
  activeScenario: Scenario = scenario,
  now?: () => number,
): () => void {
  const module = createKnowledgeModule({ search, env: {}, ...(now === undefined ? {} : { now }) });
  const stop = module.start({ hub, tasks: {} as TaskStore, scenario: activeScenario });
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
          payload: { questionId: 'q-quit', question: 'Where do players quit?', facts: [fact], agendaIndex: 0 },
        },
      ]);
      expect(fake.retainKeys).toEqual(['fact:q-quit']);
    } finally {
      stop();
    }
  });

  it('tags the fact card with the agenda item the question belongs to', async () => {
    const fake = fakeHub();
    const stop = start(async () => [fact], fake.hub);

    try {
      fake.emit(recordUpdate('q-level-5', 'game_designer', 1));
      await waitFor(() => fake.published.length > 0, 'the fact card');

      expect(fake.published[0]).toMatchObject({
        type: 'FACT_FOUND',
        payload: { questionId: 'q-level-5', agendaIndex: 1 },
      });
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

  it('waits at least fifteen seconds between retries, then gives up after three tries', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let nowMs = 0;
    let calls = 0;
    const search: SearchCompanyData = async () => {
      calls += 1;
      throw new Error('gateway down');
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub, scenario, () => nowMs);

    try {
      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(1);

      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(1);

      nowMs += 14_999;
      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(1);

      nowMs += 1;
      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(2);

      nowMs += 15_000;
      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(3);

      nowMs += 15_000;
      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(3);
      expect(fake.published).toEqual([]);
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('sends the card once when a retry succeeds after the wait', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let nowMs = 0;
    let calls = 0;
    const search: SearchCompanyData = async () => {
      calls += 1;
      if (calls === 1) throw new Error('gateway down');
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub, scenario, () => nowMs);

    try {
      fake.emit(recordUpdate());
      await settle();
      expect(calls).toBe(1);

      nowMs += 15_000;
      fake.emit(recordUpdate());
      await waitFor(() => fake.published.length === 1, 'the retried fact card');
      expect(calls).toBe(2);
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

  it('searches the agenda topic for every Wingman role once, even with no open questions', async () => {
    const calls: string[] = [];
    const search: SearchCompanyData = async (question, role) => {
      calls.push(`${question}:${role}`);
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub, wingmanScenario);

    try {
      fake.emit(recordUpdateWithNoQuestions());
      await waitFor(() => fake.published.length === 2, 'the agenda fact cards');
      fake.emit(recordUpdateWithNoQuestions());
      await settle();

      expect(calls).toEqual(['Prep. Do we prep early?:chef', 'Prep. Do we prep early?:cashier']);
      expect(fake.published).toEqual([
        {
          type: 'FACT_FOUND',
          audience: { kind: 'role', role: 'chef' },
          payload: { questionId: 'agenda-0', question: 'Prep. Do we prep early?', facts: [fact], agendaIndex: 0 },
        },
        {
          type: 'FACT_FOUND',
          audience: { kind: 'role', role: 'cashier' },
          payload: { questionId: 'agenda-0', question: 'Prep. Do we prep early?', facts: [fact], agendaIndex: 0 },
        },
      ]);
      expect(fake.retainKeys).toEqual(['fact:agenda:0:chef', 'fact:agenda:0:cashier']);
    } finally {
      stop();
    }
  });

  it('searches the new topic when the meeting moves to the next agenda item', async () => {
    const calls: string[] = [];
    const search: SearchCompanyData = async (question, role) => {
      calls.push(`${question}:${role}`);
      return [fact];
    };
    const fake = fakeHub();
    const stop = start(search, fake.hub, wingmanScenario);

    try {
      fake.emit(recordUpdateWithNoQuestions(0));
      await waitFor(() => fake.published.length === 2, 'the first topic fact cards');
      fake.emit(recordUpdateWithNoQuestions(1));
      await waitFor(() => fake.published.length === 4, 'the second topic fact cards');

      expect(calls.slice(2)).toEqual(['Stock. How much stock?:chef', 'Stock. How much stock?:cashier']);
      expect(fake.published.slice(2)).toEqual([
        {
          type: 'FACT_FOUND',
          audience: { kind: 'role', role: 'chef' },
          payload: { questionId: 'agenda-1', question: 'Stock. How much stock?', facts: [fact], agendaIndex: 1 },
        },
        {
          type: 'FACT_FOUND',
          audience: { kind: 'role', role: 'cashier' },
          payload: { questionId: 'agenda-1', question: 'Stock. How much stock?', facts: [fact], agendaIndex: 1 },
        },
      ]);
    } finally {
      stop();
    }
  });

  it('logs loudly when the agenda search finds no facts', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = fakeHub();
    const stop = start(async () => [], fake.hub, wingmanScenario);

    try {
      fake.emit(recordUpdateWithNoQuestions());
      await waitFor(() => error.mock.calls.length === 2, 'the agenda empty-result errors');
      expect(fake.published).toEqual([]);
      expect(error.mock.calls[0]?.[0]).toContain('agenda item 0');
    } finally {
      stop();
      error.mockRestore();
    }
  });

  it('still searches and publishes a fact for a real open question', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdateWithNoQuestions());
      await settle();
      expect(search).not.toHaveBeenCalled();

      fake.emit(recordUpdate());
      await waitFor(() => fake.published.length === 1, 'the open-question fact card');

      expect(search).toHaveBeenCalledWith('Where do players quit?', 'game_designer');
      expect(fake.published[0]).toMatchObject({
        type: 'FACT_FOUND',
        payload: { questionId: 'q-quit', question: 'Where do players quit?', facts: [fact], agendaIndex: 0 },
      });
    } finally {
      stop();
    }
  });

  it('settles an earlier item\'s open question without searching it again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate('q-early', 'game_designer', 1, 0));
      await settle();

      expect(search).not.toHaveBeenCalled();
      expect(fake.published).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('raised on agenda item 0'));
    } finally {
      stop();
      warn.mockRestore();
    }
  });

  it('clears settled questions on MEETING_RESET so a new meeting can look up q-1 again', async () => {
    const search = vi.fn<SearchCompanyData>(async () => [fact]);
    const fake = fakeHub();
    const stop = start(search, fake.hub);

    try {
      fake.emit(recordUpdate('q-1'));
      await waitFor(() => fake.published.length === 1, 'first meeting fact card');
      fake.emit({ type: 'MEETING_RESET', audience: { kind: 'all' }, payload: { meetingId: 'reset-meeting' } });
      fake.emit(recordUpdate('q-1'));
      await waitFor(() => fake.published.length === 2, 'second meeting fact card after reset');
      expect(search).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});
