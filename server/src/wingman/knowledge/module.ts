import { humanRoles, type KakiEvent, type SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import type { KakiContext, KakiModule } from '../../modules';
import { gatewayConfigFromEnv, missingGatewayEnv } from './gateway';
import { createCompanySearchFromEnv } from './search';

export interface KnowledgeModuleOptions {
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
  /** Questions already answered, skipped, or out of attempts. */
  settled: Set<string>;
  running: Set<string>;
  attempts: Map<string, number>;
  lastAttemptAt: Map<string, number>;
  /** The agenda item whose company records were last searched for every Wingman role. */
  lastAgendaIndex?: number;
  /** Whether this meeting's pack-free reason has already been logged. */
  packFreeLogged?: boolean;
  stopped?: boolean;
}

/** The agenda item's title and decision text, which stand in for its description in the scenario. */
function agendaQuery(item: KakiContext['scenario']['agenda'][number]): string {
  return [item.title, item.decision]
    .filter((part): part is string => part !== undefined && part.trim() !== '')
    .map((part) => part.trim())
    .join('. ');
}

/** Give every role with a Wingman the company fact for a newly reached agenda item, once per item. */
function searchAgendaTopic(
  ctx: KakiContext,
  search: SearchCompanyData,
  log: QuestionLog,
  agendaIndex: number,
): void {
  if (log.lastAgendaIndex === agendaIndex) return;
  log.lastAgendaIndex = agendaIndex;

  const item = ctx.scenario.agenda[agendaIndex];
  if (item === undefined) {
    console.error(`kaki wingman: no agenda item ${agendaIndex} to search company records for`);
    return;
  }
  const query = agendaQuery(item);
  for (const role of humanRoles(ctx.scenario)) {
    void (async () => {
      try {
        const facts = await search(query, role.id);
        if (log.stopped) return;
        if (facts.length === 0) {
          console.error(
            `kaki wingman: no company facts found for agenda item ${agendaIndex} "${item.title}" (${role.id})`,
          );
          return;
        }
        ctx.hub.publish(
          {
            type: 'FACT_FOUND',
            audience: { kind: 'role', role: role.id },
            payload: { questionId: `agenda-${agendaIndex}`, question: query, facts, agendaIndex },
          },
          { retainKey: `fact:agenda:${agendaIndex}:${role.id}` },
        );
      } catch (error) {
        if (log.stopped) return;
        console.error(
          `kaki wingman: company search failed for agenda item ${agendaIndex} "${item.title}" (${role.id}):`,
          error,
        );
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
    log.lastAgendaIndex = undefined;
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
  searchAgendaTopic(ctx, search, log, agendaIndex);

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
    if (attempt >= MAX_SEARCH_ATTEMPTS) log.settled.add(question.id);
    log.running.add(question.id);

    void (async () => {
      try {
        const facts = await search(question.text, role);
        if (log.stopped) return;
        if (facts.length === 0) {
          console.error(
            `kaki wingman: no company facts found for question ${question.id} (${role}), attempt ${attempt}`,
          );
          return;
        }
        ctx.hub.publish(
          {
            type: 'FACT_FOUND',
            audience: { kind: 'role', role },
            payload: { questionId: question.id, question: question.text, facts, agendaIndex },
          },
          { retainKey: `fact:${question.id}` },
        );
        log.settled.add(question.id);
      } catch (error) {
        if (log.stopped) return;
        console.error(
          `kaki wingman: company search failed for question ${question.id} (${role}), attempt ${attempt}:`,
          error,
        );
      } finally {
        log.running.delete(question.id);
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

export const knowledgeModule = createKnowledgeModule();
