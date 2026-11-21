import {
  humanRoles,
  type Fact,
  type KakiEvent,
  type Role,
  type Scenario,
  type SearchCompanyData,
} from '@kaki/shared';
import { Pool } from 'pg';
import type { KakiContext, KakiModule } from '../../core/modules';
import { gatewayConfigFromEnv, missingGatewayEnv } from './gateway';
import { createCompanySearchFromEnv } from './search';

interface KnowledgeModuleOptions {
  /** A prepared search, used by tests and the check script. */
  search?: SearchCompanyData;
  env?: NodeJS.ProcessEnv;
  /** Clock used to space a question's retries; tests fix it. */
  now?: () => number;
}

function missingSearchEnv(env: NodeJS.ProcessEnv): string[] {
  return [...missingGatewayEnv(env), ...(env.POSTGRES_URL ? [] : ['POSTGRES_URL'])];
}

/** How many times a question is searched before Kaki gives up; a failed search retries on a later record. */
const MAX_SEARCH_ATTEMPTS = 3;
/** A question is not searched again until this long after its previous attempt. */
const RETRY_INTERVAL_MS = 15_000;

interface QuestionLog {
  /** Questions and agenda searches already answered, skipped, or out of attempts. */
  settled: Set<string>;
  running: Set<string>;
  attempts: Map<string, number>;
  lastAttemptAt: Map<string, number>;
  /** Agenda searches whose exhaustion has already been shown, so the room hears it once. */
  exhausted: Set<string>;
  /** Whether this meeting's pack-free reason has already been logged. */
  packFreeLogged?: boolean;
  stopped?: boolean;
}

/** The agenda item's title and decision text, which stand in for its description in the scenario. */
function agendaQuery(item: Scenario['agenda'][number]): string {
  return [item.title, item.decision]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .map((part) => part.trim())
    .join('. ');
}

/** Tell one role that its search kept failing, so a missing card is never silent. */
function publishExhausted(
  ctx: KakiContext,
  log: QuestionLog,
  key: string,
  role: Role,
  agendaIndex: number,
  subject: string,
): void {
  log.settled.add(key);
  if (log.exhausted.has(key)) return;
  log.exhausted.add(key);
  ctx.hub.publish(
    {
      type: 'NUDGE',
      audience: { kind: 'role', role },
      payload: { text: `Kaki's company search isn't working right now, so there is no record check for ${subject}.`, agendaIndex },
    },
    { retainKey: `fact-missing:${key}` },
  );
}

/** Search the agenda item for every Wingman role; keep trying after a failure until it succeeds or runs out. */
function searchAgendaTopic(
  ctx: KakiContext,
  search: SearchCompanyData,
  log: QuestionLog,
  now: () => number,
  agendaIndex: number,
): void {
  const item = ctx.activeScenario().agenda[agendaIndex];
  if (item === undefined) {
    console.error(`kaki wingman: no agenda item ${agendaIndex} to search company records for`);
    return;
  }
  const query = agendaQuery(item);
  for (const role of humanRoles(ctx.activeScenario())) {
    const key = `agenda:${agendaIndex}:${role.id}`;
    if (log.settled.has(key) || log.running.has(key)) continue;

    const previousAttempts = log.attempts.get(key) ?? 0;
    if (previousAttempts > 0) {
      const lastAttemptAt = log.lastAttemptAt.get(key) ?? 0;
      if (now() - lastAttemptAt < RETRY_INTERVAL_MS) continue;
    }

    const attempt = previousAttempts + 1;
    log.attempts.set(key, attempt);
    log.lastAttemptAt.set(key, now());
    log.running.add(key);

    void (async () => {
      let facts: Fact[] | undefined;
      let failure: unknown;
      try {
        facts = await search(query, role.id);
      } catch (error) {
        failure = error;
      } finally {
        log.running.delete(key);
      }
      if (log.stopped) return;

      if (facts !== undefined && facts.length > 0) {
        ctx.hub.publish(
          {
            type: 'FACT_FOUND',
            audience: { kind: 'role', role: role.id },
            payload: { questionId: `agenda-${agendaIndex}`, question: query, facts, agendaIndex },
          },
          { retainKey: `fact:agenda:${agendaIndex}:${role.id}` },
        );
        log.settled.add(key);
        return;
      }

      if (failure !== undefined) {
        console.error(
          `kaki wingman: company search failed for agenda item ${agendaIndex} "${item.title}" (${role.id}), attempt ${attempt}:`,
          failure,
        );
      } else {
        // An empty result is an answer, not a failure: the records hold nothing for this item. No retry, no notice.
        console.warn(`kaki wingman: no company facts found for agenda item ${agendaIndex} "${item.title}" (${role.id})`);
        log.settled.add(key);
        return;
      }
      if (attempt >= MAX_SEARCH_ATTEMPTS) {
        publishExhausted(ctx, log, key, role.id, agendaIndex, `“${item.title}”`);
      }
    })();
  }
}

function handleEvent(
  ctx: KakiContext,
  search: SearchCompanyData,
  log: QuestionLog,
  now: () => number,
  event: KakiEvent,
): void {
  if (log.stopped) return;
  if (event.type === 'MEETING_RESET') {
    log.settled.clear();
    log.running.clear();
    log.attempts.clear();
    log.lastAttemptAt.clear();
    log.exhausted.clear();
    log.packFreeLogged = false;
    return;
  }
  if (event.type !== 'MEETING_RECORD_UPDATED') return;

  // A pack-free meeting (no AI seats and no demo-pack topic) must never show another pack's records.
  if (ctx.packFree?.() === true) {
    if (log.packFreeLogged !== true) {
      log.packFreeLogged = true;
      console.log(
        'kaki wingman: company knowledge is off for this pack-free meeting; it has no AI seats and no demo-pack topics',
      );
    }
    return;
  }

  const { agendaIndex } = event.payload;
  searchAgendaTopic(ctx, search, log, now, agendaIndex);

  for (const question of event.payload.openQuestions) {
    if (log.settled.has(question.id) || log.running.has(question.id)) continue;
    // Only the current item's questions are searched. An earlier item's question stays in the shared record but no
    // longer matters here, so settle it; a later item's question waits until the meeting reaches that item.
    if (question.agendaIndex < agendaIndex) {
      log.settled.add(question.id);
      console.warn(
        `kaki wingman: settling question ${question.id}; it was raised on agenda item ${question.agendaIndex}, the meeting is on ${agendaIndex}`,
      );
      continue;
    }
    if (question.agendaIndex > agendaIndex) continue;
    if (question.forRole === undefined) {
      log.settled.add(question.id);
      console.warn(`kaki wingman: open question ${question.id} has no role, skipping company search`);
      continue;
    }

    const role = question.forRole;
    const previousAttempts = log.attempts.get(question.id) ?? 0;
    if (previousAttempts > 0) {
      const lastAttemptAt = log.lastAttemptAt.get(question.id) ?? 0;
      if (now() - lastAttemptAt < RETRY_INTERVAL_MS) continue;
    }

    const attempt = previousAttempts + 1;
    log.attempts.set(question.id, attempt);
    log.lastAttemptAt.set(question.id, now());
    log.running.add(question.id);

    void (async () => {
      let facts: Fact[] | undefined;
      let failure: unknown;
      try {
        facts = await search(question.text, role);
      } catch (error) {
        failure = error;
      } finally {
        log.running.delete(question.id);
      }
      if (log.stopped) return;

      if (facts !== undefined && facts.length > 0) {
        ctx.hub.publish(
          {
            type: 'FACT_FOUND',
            audience: { kind: 'role', role },
            payload: { questionId: question.id, question: question.text, facts, agendaIndex },
          },
          { retainKey: `fact:${question.id}` },
        );
        log.settled.add(question.id);
        return;
      }

      if (failure !== undefined) {
        console.error(
          `kaki wingman: company search failed for question ${question.id} (${role}), attempt ${attempt}:`,
          failure,
        );
      } else {
        console.warn(`kaki wingman: no company facts found for question ${question.id} (${role})`);
        log.settled.add(question.id);
        return;
      }
      if (attempt >= MAX_SEARCH_ATTEMPTS) {
        publishExhausted(ctx, log, question.id, role, agendaIndex, 'this question');
      }
    })();
  }
}

/** The module that answers open meeting questions from the fake company's records. */
export function createKnowledgeModule(options: KnowledgeModuleOptions = {}): KakiModule {
  return {
    name: 'wingman-knowledge',
    start(ctx) {
      const env = options.env ?? process.env;
      let search = options.search;
      let pool: Pool | undefined;

      if (search === undefined) {
        const missing = missingSearchEnv(env);
        if (gatewayConfigFromEnv(env) === undefined || missing.length > 0) {
          console.log(
            `kaki wingman: company search disabled (missing ${[...new Set(missing)].join(', ')})`,
          );
          return;
        }
        pool = new Pool({ connectionString: env.POSTGRES_URL });
        // An idle connection dying (database restart) must not crash the server.
        pool.on('error', (error) => console.error('kaki wingman: company search database error', error));
        search = createCompanySearchFromEnv(env, pool);
      }

      const now = options.now ?? Date.now;
      const log: QuestionLog = {
        settled: new Set(),
        running: new Set(),
        attempts: new Map(),
        lastAttemptAt: new Map(),
        exhausted: new Set(),
      };
      const unsubscribe = ctx.hub.subscribe((event) => handleEvent(ctx, search, log, now, event));
      return () => {
        log.stopped = true;
        unsubscribe();
        if (pool) void pool.end();
      };
    },
  };
}

/** The Wingman module that searches company knowledge and answers room questions. */
export const knowledgeModule = createKnowledgeModule();
