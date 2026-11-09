import { loadEnv, saveEnv } from './env';
import { seedGitea } from './gitea';
import { seedMail } from './mail';
import { seedMattermost } from './mattermost';
import { seedPostgres } from './postgres';
import { loadScenarioSeed } from './scenario';
import { seedWiki } from './wiki';

async function main(): Promise<void> {
  const scenarioName = process.env.SCENARIO ?? 'kopitiam';
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
  const gitea = await seedGitea(env, seed.gitea, seed.organisation);
  env.GITEA_REPO = gitea.repo;
  env.GITEA_TOKEN = gitea.token;
  saveEnv(env);

  console.log('Mattermost');
  env.MATTERMOST_TEAM = seed.mattermost.team.name;
  env.MATTERMOST_TOKEN = await seedMattermost(env, seed.mattermost);
  saveEnv(env);

  console.log('Mailpit');
  await seedMail(env, seed.emails);

  console.log('Radicale Calendar');
  try {
    const calBase = 'http://127.0.0.1:5232/user/calendar/';
    await fetch('http://127.0.0.1:5232/user/', { method: 'MKCOL' }).catch(() => undefined);
    await fetch(calBase, { method: 'MKCALENDAR' }).catch(() => undefined);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    const events = [
      {
        id: 'seed-straits-times-press',
        dtstart: `${tomorrow}T080000`,
        dtend: `${tomorrow}T084500`,
        summary: 'Straits Times Food Desk — Flagship Ribbon-Cutting & Tasting',
        description: 'Raffles Place #B1-14 storefront ribbon-cutting and Set A tasting.',
      },
      {
        id: 'seed-sfa-inspection',
        dtstart: `${tomorrow}T090000`,
        dtend: `${tomorrow}T094500`,
        summary: 'SFA On-Site Food Hygiene Inspection (Sous-Vide Egg Bath & Batch Logs)',
        description: 'SFA Central Regional officers inspecting 63C holding bath and Batch #402/#405 logs.',
      },
      {
        id: 'seed-morning-rush-debrief',
        dtstart: `${tomorrow}T103000`,
        dtend: `${tomorrow}T110000`,
        summary: 'Post-Rush Kiosk & 28-Seat Floor Turnover Check',
        description: 'Review Step 2 Kopi O Kosong completion times and morning booth turnover.',
      },
    ];
    for (const ev of events) {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Kaki//NONSGML v1.0//EN',
        'BEGIN:VEVENT',
        `UID:${ev.id}@kaki.local`,
        `DTSTAMP:${tomorrow}T000000Z`,
        `DTSTART:${ev.dtstart}`,
        `DTEND:${ev.dtend}`,
        `SUMMARY:${ev.summary}`,
        `DESCRIPTION:${ev.description}`,
        'END:VEVENT',
        'END:VCALENDAR',
        '',
      ].join('\r\n');
      await fetch(`${calBase}${ev.id}.ics`, {
        method: 'PUT',
        headers: { 'content-type': 'text/calendar; charset=utf-8' },
        body: ics,
      });
    }
    console.log('  seeded 3 Kopitiam calendar events');
  } catch {
    // Non-fatal if Radicale is not running.
  }

  console.log('\nSeed complete. Credentials and URLs are in docker/.env.');
}

main().catch((error: unknown) => {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.cause) {
    console.error(`Caused by: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  }
  process.exitCode = 1;
});
