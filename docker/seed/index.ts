import { loadEnv, saveEnv } from './env';
import { seedGitea } from './gitea';
import { seedMail } from './mail';
import { seedMattermost } from './mattermost';
import { seedPostgres } from './postgres';
import { loadScenarioSeed } from './scenario';
import { seedWiki } from './wiki';

async function main(): Promise<void> {
  const scenarioName = process.env.SCENARIO ?? 'pixel-kampung';
  const seed = loadScenarioSeed(scenarioName);
  const env = loadEnv();
  env.SCENARIO = scenarioName;
  saveEnv(env);

  console.log(`Seeding scenario "${scenarioName}"`);

  console.log('Postgres');
  await seedPostgres(env, seed);

  console.log('Wiki.js');
  await seedWiki(env, seed.pages);

  console.log('Gitea');
  const gitea = await seedGitea(env, seed.gitea);
  env.GITEA_REPO = gitea.repo;
  env.GITEA_TOKEN = gitea.token;
  saveEnv(env);

  console.log('Mattermost');
  env.MATTERMOST_TOKEN = await seedMattermost(env, seed.mattermost);
  saveEnv(env);

  console.log('Mailpit');
  await seedMail(env, seed.emails);

  console.log('\nSeed complete. Credentials and URLs are in docker/.env.');
}

main().catch((error: unknown) => {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.cause) {
    console.error(`Caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  }
  process.exitCode = 1;
});
