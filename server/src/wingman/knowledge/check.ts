// Must stay first: loads root .env before reading gateway credentials.
import '../../env';
import type { Fact, Role, SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import { loadEnv } from '../../../../docker/seed/env';
import { SAMPLE_WORKSPACE_ID } from '../../workspace/constants';
import { chatComplete, embedText, gatewayConfigFromEnv, missingGatewayEnv } from './gateway';
import {
  createSearchCompanyData,
  retrieveFromPostgres,
  type RetrievedChunk,
} from './search';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface Trace {
  search: SearchCompanyData;
  top: () => RetrievedChunk[];
}

function tracedSearch(pool: Pool, gateway: NonNullable<ReturnType<typeof gatewayConfigFromEnv>>): Trace {
  let top: RetrievedChunk[] = [];
  const search = createSearchCompanyData({
    embed: (text) => embedText(gateway, text),
    chat: (prompt) => chatComplete(gateway, prompt),
    retrieve: (embedding, question, limit) =>
      retrieveFromPostgres(pool, SAMPLE_WORKSPACE_ID, embedding, question, limit),
    onRetrieved: (chunks) => {
      top = chunks.slice(0, 3);
    },
  });
  return { search, top: () => top };
}

async function main(): Promise<void> {
  const env = loadEnv();
  const gateway = gatewayConfigFromEnv(process.env);
  if (gateway === undefined) {
    throw new Error(`Set ${missingGatewayEnv().join(' and ')} before running knowledge:check`);
  }

  const pool = new Pool({ connectionString: env.POSTGRES_URL });
  try {
    const questions: Array<{
      role: Role;
      text: string;
      expectedRef: RegExp;
      check: (facts: Fact[]) => void;
    }> = [
      {
        role: 'menu_store_lead',
        text: 'What do the records say about the old regulars and the new kopi prices?',
        expectedRef: /regulars_pricing\/|kopi-pricing|kopi-prices/,
        check: (facts) => {
          const text = facts.map((fact) => fact.text).join('\n');
          assert(/kopi|regular/i.test(text), `designer facts do not mention the regulars or kopi: ${text}`);
          assert(/1\.30|2\.40|1\.60/i.test(text), `designer facts do not mention the prices: ${text}`);
        },
      },
      {
        role: 'operations_director',
        text: 'What is the delivery commission margin and the food-safety goodwill limit?',
        expectedRef: /delivery_commission_tiers\/|food_safety_incident\/|delivery-pricing/,
        check: (facts) => {
          const text = facts.map((fact) => fact.text).join('\n');
          assert(/32%|0\.50|2,?400/i.test(text), `operations_director facts do not mention the delivery commission: ${text}`);
          assert(/3,?000|goodwill/i.test(text), `operations_director facts do not mention the goodwill limit: ${text}`);
        },
      },
    ];

    for (const question of questions) {
      const trace = tracedSearch(pool, gateway);
      const started = performance.now();
      const facts = await trace.search(question.text, question.role);
      const seconds = (performance.now() - started) / 1000;
      const top = trace.top();

      console.log(`\nQuestion for ${question.role}: ${question.text}`);
      for (const [index, chunk] of top.entries()) {
        console.log(`  top ${index + 1}: ${chunk.source}:${chunk.ref} (${chunk.publishedAt})`);
      }
      for (const fact of facts) {
        console.log(`  fact [${fact.source}, ${fact.date}]: ${fact.text}`);
      }
      console.log(`  elapsed: ${seconds.toFixed(1)}s`);

      assert(top.length > 0, `${question.role}: no chunks retrieved`);
      assert(
        top.some((chunk) => question.expectedRef.test(chunk.ref)),
        `${question.role}: expected source missing from the top 3`,
      );
      assert(facts.length > 0, `${question.role}: no facts returned`);
      question.check(facts);
      console.log(`PASS ${question.role}`);
    }

    console.log('\nAll company search checks passed.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\nKnowledge check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
