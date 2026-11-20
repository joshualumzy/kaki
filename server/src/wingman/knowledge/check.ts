// Must stay first: loads root .env before reading gateway credentials.
import '../../env';
import type { Fact, KakiEvent, Role, Scenario, SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import { loadEnv } from '../../../../docker/seed/env';
import type { TaskStore } from '../../tasks';
import { audienceLabel, roleAudience, type ClientAudience, type Hub } from '../../hub';
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
  meetingTitle: 'Raffles Place Flagship Opening Day',
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
  agenda: [
    {
      title: 'Old regulars and the new kopi prices',
      minutes: 5,
      canWait: false,
      deadline: 'before doors open at 8',
      ownerRole: 'game_designer',
    },
  ],
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
    retrieve: (embedding, question, limit) => retrieveFromPostgres(pool, embedding, question, limit),
    onRetrieved: (chunks) => {
      top = chunks.slice(0, 3);
    },
  });
  return { search, top: () => top };
}

function wantsEvent(event: KakiEvent, audience: ClientAudience): boolean {
  return (
    event.audience.kind === 'all' ||
    (event.audience.kind === 'screen' && audience.kind === 'screen') ||
    (event.audience.kind === 'role' &&
      audience.kind === 'role' &&
      audience.role === event.audience.role)
  );
}

interface InMemoryHub {
  hub: Hub;
  received(audience: ClientAudience): KakiEvent[];
}

function inMemoryHub(audiences: ClientAudience[]): InMemoryHub {
  const handlers = new Set<(event: KakiEvent) => void>();
  const delivered = new Map<string, KakiEvent[]>(
    audiences.map((audience) => [audienceLabel(audience), []]),
  );
  const hub: Hub = {
    publish(event) {
      for (const [label, events] of delivered) {
        const audience = audiences.find((candidate) => audienceLabel(candidate) === label);
        if (audience !== undefined && wantsEvent(event, audience)) events.push(event);
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
    received: (audience) => delivered.get(audienceLabel(audience)) ?? [],
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
  const fake = inMemoryHub([
    { kind: 'screen' },
    roleAudience('producer'),
    roleAudience('lead_programmer'),
    roleAudience('game_designer'),
    roleAudience('marketing_lead'),
  ]);
  const module = createKnowledgeModule({
    env: {},
    search: async (): Promise<Fact[]> => [
      { text: 'Level 5 has the quit spike.', source: 'postgres', date: '2026-11-10' },
    ],
  });
  const stop = module.start({ hub: fake.hub, tasks: {} as TaskStore, activeScenario: () => scenario });
  try {
    fake.hub.publish({
      type: 'MEETING_RECORD_UPDATED',
      audience: { kind: 'all' },
      payload: {
        agendaIndex: 1,
        openQuestions: [
          { id: 'q-quit', text: 'Where do players quit?', forRole: 'game_designer', agendaIndex: 1 },
        ],
        elapsedSeconds: 10,
        speakerTalkSeconds: {},
      },
    });
    const questionCards = (audience: ClientAudience): KakiEvent[] =>
      fake.received(audience).filter(
        (event): event is Extract<KakiEvent, { type: 'FACT_FOUND' }> =>
          event.type === 'FACT_FOUND' && event.payload.questionId === 'q-quit',
      );
    await waitFor(() => questionCards(roleAudience('game_designer')).length > 0, 'the game designer card');
    assert(questionCards(roleAudience('producer')).length === 0, 'the producer received the question card');
    assert(questionCards(roleAudience('lead_programmer')).length === 0, 'the lead programmer received the question card');
    assert(questionCards(roleAudience('marketing_lead')).length === 0, 'the marketing lead received the question card');
    const card = questionCards(roleAudience('game_designer'))[0];
    assert(card !== undefined, 'the game designer did not receive the question card');
    assert(card.audience.kind === 'role' && card.audience.role === 'game_designer', 'the card audience is wrong');
    console.log('PASS hub check: the question FACT_FOUND went only to game_designer');
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
        text: 'What do the records say about the old regulars and the new kopi prices?',
        expectedRef: /regulars_pricing\/|kopi-pricing|kopi-prices/,
        check: (facts) => {
          const text = facts.map((fact) => fact.text).join('\n');
          assert(/kopi|regular/i.test(text), `designer facts do not mention the regulars or kopi: ${text}`);
          assert(/1\.30|2\.40|1\.60/i.test(text), `designer facts do not mention the prices: ${text}`);
        },
      },
      {
        role: 'producer',
        text: 'What is the delivery commission margin and the food-safety goodwill limit?',
        expectedRef: /delivery_commission_tiers\/|food_safety_incident\/|delivery-pricing/,
        check: (facts) => {
          const text = facts.map((fact) => fact.text).join('\n');
          assert(/32%|0\.50|2,?400/i.test(text), `producer facts do not mention the delivery commission: ${text}`);
          assert(/3,?000|goodwill/i.test(text), `producer facts do not mention the goodwill limit: ${text}`);
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
