import type { Fact, KakiEvent, Role, Scenario, SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import { loadEnv } from '../../../../docker/seed/env';
import type { TaskStore } from '../../tasks';
import type { ClientAudience, Hub } from '../../hub';
import { chatComplete, embedText, gatewayConfigFromEnv, missingGatewayEnv } from './gateway';
import { createKnowledgeModule } from './module';
import {
  createSearchCompanyData,
  retrieveFromPostgres,
  type RetrievedChunk,
} from './search';

const scenario: Scenario = {
  id: 'kopitiam',
  organisation: 'Nanyang Kopi & Toast',
  meetingTitle: 'Raffles Place Flagship & App Promo Launch',
  roles: [
    { id: 'producer', label: 'Operations Director' },
    { id: 'lead_programmer', label: 'Tech & POS Lead' },
    { id: 'game_designer', label: 'Menu & Store Experience Lead' },
    { id: 'marketing_lead', label: 'Marketing Lead' },
  ],
  attendees: [
    { name: 'Wei Ling', role: 'producer', zoomDisplayName: 'Wei Ling' },
    { name: 'Arjun', role: 'lead_programmer', zoomDisplayName: 'Arjun' },
    { name: 'Mei', role: 'game_designer', zoomDisplayName: 'Mei' },
    { name: 'Daniel', role: 'marketing_lead', zoomDisplayName: 'Daniel' },
  ],
  agenda: [{ title: 'Kiosk menu language', minutes: 10, ownerRole: 'game_designer' }],
};

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
    retrieve: (embedding, limit) => retrieveFromPostgres(pool, embedding, limit),
    onRetrieved: (chunks) => {
      top = chunks.slice(0, 3);
    },
  });
  return { search, top: () => top };
}

function wantsEvent(event: KakiEvent, audience: ClientAudience): boolean {
  return (
    event.audience.kind === 'all' ||
    (event.audience.kind === 'screen' && audience === 'screen') ||
    (event.audience.kind === 'role' && audience === event.audience.role)
  );
}

interface InMemoryHub {
  hub: Hub;
  received(audience: ClientAudience): KakiEvent[];
}

function inMemoryHub(audiences: ClientAudience[]): InMemoryHub {
  const handlers = new Set<(event: KakiEvent) => void>();
  const delivered = new Map<ClientAudience, KakiEvent[]>(
    audiences.map((audience) => [audience, []]),
  );
  const hub: Hub = {
    publish(event) {
      for (const [audience, events] of delivered) {
        if (wantsEvent(event, audience)) events.push(event);
      }
      for (const handler of handlers) handler(event);
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onCommand() {
      throw new Error('The check hub does not accept commands');
    },
    clearRetained() {},
    close() {
      handlers.clear();
      delivered.clear();
    },
  };
  return {
    hub,
    received: (audience) => delivered.get(audience) ?? [],
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function checkAudience(): Promise<void> {
  const fake = inMemoryHub(['screen', 'producer', 'lead_programmer', 'game_designer', 'marketing_lead']);
  const module = createKnowledgeModule({
    env: {},
    search: async (): Promise<Fact[]> => [
      { text: 'Level 5 has the quit spike.', source: 'postgres', date: '2026-11-10' },
    ],
  });
  const stop = module.start({ hub: fake.hub, tasks: {} as TaskStore, scenario });
  try {
    fake.hub.publish({
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: {
        agendaIndex: 1,
        openQuestions: [
          { id: 'q-quit', text: 'Where do players quit?', forRole: 'game_designer' },
        ],
        elapsedSeconds: 10,
        speakerTalkSeconds: {},
      },
    });
    await waitFor(
      () => fake.received('game_designer').some((event) => event.type === 'FACT_FOUND'),
      'the game designer card',
    );
    assert(
      fake.received('producer').every((event) => event.type !== 'FACT_FOUND'),
      'the producer received a FACT_FOUND card',
    );
    assert(
      fake.received('lead_programmer').every((event) => event.type !== 'FACT_FOUND'),
      'the lead programmer received a FACT_FOUND card',
    );
    assert(
      fake.received('marketing_lead').every((event) => event.type !== 'FACT_FOUND'),
      'the marketing lead received a FACT_FOUND card',
    );
    const card = fake.received('game_designer').find((event) => event.type === 'FACT_FOUND');
    assert(card?.audience.kind === 'role' && card.audience.role === 'game_designer', 'the card audience is wrong');
    console.log('PASS hub check: FACT_FOUND went only to game_designer');
  } finally {
    if (typeof stop === 'function') stop();
  }
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
        role: 'game_designer',
        text: 'What did the kiosk trial show about first-time users?',
        expectedRef: /kiosk_trial_stats\/|kiosk-menu-sop|kiosk-trials/,
        check: (facts) => {
          const text = facts.map((fact) => fact.text).join('\n');
          assert(/kiosk|kopi o kosong/i.test(text), `designer facts do not mention the kiosk: ${text}`);
          assert(/19\s*(of|\/)\s*28|72%|first-time/i.test(text), `designer facts do not mention the trial numbers: ${text}`);
        },
      },
      {
        role: 'producer',
        text: 'What is our remaining launch budget and butter margin risk?',
        expectedRef: /launch_budget|butter_costing|mall-promo-rules/,
        check: (facts) => {
          const text = facts.map((fact) => fact.text).join('\n');
          assert(/\$?750|launch budget/i.test(text), `producer facts do not mention the remaining budget: ${text}`);
          assert(/35%|1,?100|anchor/i.test(text), `producer facts do not mention the butter cost: ${text}`);
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

    await checkAudience();
    console.log('\nAll company search checks passed.');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\nKnowledge check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
