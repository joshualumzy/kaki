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
    await fetch(calBase, { method: 'DELETE' }).catch(() => undefined);
    await fetch('http://127.0.0.1:5232/user/', { method: 'MKCOL' }).catch(() => undefined);
    await fetch(calBase, { method: 'MKCALENDAR' }).catch(() => undefined);
    const trialDay = '20261110';
    const openingDay = '20261111';
    const plus2 = '20261113';
    const plus5 = '20261116';

    const events = [
      {
        id: 'seed-trial-day',
        dtstart: `${trialDay}T080000`,
        dtend: `${trialDay}T103000`,
        summary: 'Raffles Place - Trial-Day Breakfast Service',
        description: 'Counter queue, seating turnover, new kopi prices and delivery app orders during the trial breakfast.',
      },
      {
        id: 'seed-opening-staffing-call',
        dtstart: `${openingDay}T063000`,
        dtend: `${openingDay}T070000`,
        summary: 'Opening Day - Counter Cover Call',
        description: 'Two counter staff planned for 8 to 10; Siti is out for a family emergency after texting at quarter to seven. Rest-day double pay, agency notice and till login on the table.',
      },
      {
        id: 'seed-opening-fridge-check',
        dtstart: `${openingDay}T061500`,
        dtend: `${openingDay}T064500`,
        summary: 'Opening Day - Prep Fridge Check and Disposal Log',
        description: 'Head chef found the prep fridge unplugged overnight after the trial, threw out the contents and signed the disposal log at 6:10.',
      },
      {
        id: 'seed-opening-delivery-review',
        dtstart: `${openingDay}T070000`,
        dtend: `${openingDay}T073000`,
        summary: 'Opening Day - Delivery App Margin Review',
        description: 'Check the 32% commission, single-set loss and the Office Platter and direct pickup margins before the app goes live.',
      },
      {
        id: 'seed-food-agency-inspection',
        dtstart: `${openingDay}T090000`,
        dtend: `${openingDay}T094500`,
        summary: 'Food Agency On-Site Inspection',
        description: 'Routine opening-day inspection booked weeks ago; the officer reviews the signed disposal log, the fridge temperature log and the delivery record for the replacement eggs and kaya.',
      },
      {
        id: 'seed-blogger-visit',
        dtstart: `${openingDay}T103000`,
        dtend: `${openingDay}T111500`,
        summary: 'Food Blogger Visit - Set A and Kopi Bar',
        description: 'Jia Hui photographs Set A, the kopi bar and the breakfast crowd.',
      },
      {
        id: 'seed-arrival-check',
        dtstart: `${openingDay}T074500`,
        dtend: `${openingDay}T080000`,
        summary: 'Opening Day - Doors Open',
        description: 'Final walk of the counter, kiosk and seating before the 8 o clock doors.',
      },
      {
        id: 'seed-post-rush-seating-review',
        dtstart: `${openingDay}T110000`,
        dtend: `${openingDay}T113000`,
        summary: 'Post-Rush Seating and Laptop Review',
        description: 'Review seat turnover, the window-bar stools and the booth socket timer after the first rush.',
      },
      {
        id: 'seed-office-pickup-follow-up',
        dtstart: `${plus2}T150000`,
        dtend: `${plus2}T160000`,
        summary: 'Office Direct Pickup Code Follow-Up',
        description: 'Agree the direct order code and pickup shelf for the 12 office managers who asked.',
      },
      {
        id: 'seed-kaya-delivery',
        dtstart: `${plus2}T070000`,
        dtend: `${plus2}T074500`,
        summary: 'Pandan Kaya and Hainanese Loaf Restock',
        description: 'Morning delivery of house pandan kaya and thick-cut loaves for the week.',
      },
      {
        id: 'seed-roaster-cupping',
        dtstart: `${plus5}T143000`,
        dtend: `${plus5}T153000`,
        summary: 'Liberica and Robusta Butter-Roast Cupping',
        description: 'Check the Nanyang roast profile and sock-brew extraction with Uncle Lim and Mei.',
      },
    ];
    for (const ev of events) {
      const ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Kaki//NONSGML v1.0//EN',
        'BEGIN:VEVENT',
        `UID:${ev.id}@kaki.local`,
        `DTSTAMP:${openingDay}T000000Z`,
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
    console.log(`  seeded ${events.length} Kopitiam calendar events`);
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
