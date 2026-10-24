import type { KakiEvent, SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import type { KakiContext, KakiModule } from '../../modules';
import { gatewayConfigFromEnv, missingGatewayEnv } from './gateway';
import { createCompanySearchFromEnv } from './search';

export interface KnowledgeModuleOptions {
  /** A prepared search, used by tests and the check script. */
  search?: SearchCompanyData;
  env?: NodeJS.ProcessEnv;
}

function missingSearchEnv(env: NodeJS.ProcessEnv): string[] {
  return [...missingGatewayEnv(env), ...(env.POSTGRES_URL ? [] : ['POSTGRES_URL'])];
}

function handleEvent(
  ctx: KakiContext,
  search: SearchCompanyData,
  handled: Set<string>,
  event: KakiEvent,
): void {
  if (event.type !== 'MEETING_RECORD_UPDATED') return;

  for (const question of event.payload.openQuestions) {
    if (handled.has(question.id)) continue;
    handled.add(question.id);
    if (question.forRole === undefined) {
      console.warn(`kaki wingman: open question ${question.id} has no role, skipping company search`);
      continue;
    }

    const role = question.forRole;
    void (async () => {
      try {
        const facts = await search(question.text, role);
        if (facts.length === 0) {
          console.error(`kaki wingman: no company facts found for question ${question.id} (${role})`);
          return;
        }
        ctx.hub.publish(
          {
            type: 'FACT_FOUND',
            audience: { kind: 'role', role },
            payload: { questionId: question.id, question: question.text, facts },
          },
          { retainKey: `fact:${question.id}` },
        );
      } catch (error) {
        console.error(
          `kaki wingman: company search failed for question ${question.id} (${role}):`,
          error,
        );
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
        search = createCompanySearchFromEnv(env, pool);
      }

      const handled = new Set<string>();
      const unsubscribe = ctx.hub.subscribe((event) => handleEvent(ctx, search, handled, event));
      return () => {
        unsubscribe();
        if (pool) void pool.end();
      };
    },
  };
}

export const knowledgeModule = createKnowledgeModule();
