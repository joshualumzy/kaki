import { loadEnv } from '../../../../docker/seed/env';
import { indexKnowledge, probeServices } from './indexer';

async function main(): Promise<void> {
  const env = loadEnv();
  console.log(`Indexing company knowledge (scenario: ${env.SCENARIO})`);
  await probeServices(env);
  const summary = await indexKnowledge({ env });
  console.log(
    `Indexed ${summary.chunks} chunks: ${Object.entries(summary.sources)
      .map(([source, count]) => `${source} ${count}`)
      .join(', ')}`,
  );
}

main().catch((error: unknown) => {
  console.error(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.cause) {
    console.error(`Caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  }
  process.exitCode = 1;
});
