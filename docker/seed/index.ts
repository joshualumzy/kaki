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
    const dayOffset = (days: number): string =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
    const dMinus2 = dayOffset(-2);
    const dMinus1 = dayOffset(-1);
    const dToday = dayOffset(0);
    const tomorrow = dayOffset(1);
    const dPlus2 = dayOffset(2);
    const dPlus3 = dayOffset(3);
    const dPlus5 = dayOffset(5);

    const events = [
      {
        id: 'seed-tampines-printer-test',
        dtstart: `${dMinus2}T140000`,
        dtend: `${dMinus2}T153000`,
        summary: 'Tampines Outlet — Thermal Kitchen Docket & POS v2.4 Trial',
        description: 'Tested dual-label POS v2.4 kitchen docket printing with Uncle Lim and Uncle Tan.',
      },
      {
        id: 'seed-soft-launch-kiosk-trial',
        dtstart: `${dMinus1}T080000`,
        dtend: `${dMinus1}T103000`,
        summary: 'Raffles Place #B1-14 — Soft Trial (28 First-Time Kiosk Users)',
        description: 'Observed Step 2 Kopi O Kosong checkout time, 28-seat booth turnover, and sous-vide egg bath holding.',
      },
      {
        id: 'seed-seng-choon-batch405',
        dtstart: `${dToday}T063000`,
        dtend: `${dToday}T071500`,
        summary: 'Seng Choon Farm — Pasteurized Egg Batch #405 Cold-Chain Delivery',
        description: 'Receive 2 backup cartons of SFA-certified pasteurized eggs at Raffles Place loading bay.',
      },
      {
        id: 'seed-prelaunch-crisis-huddle',
        dtstart: `${dToday}T160000`,
        dtend: `${dToday}T164500`,
        summary: 'Raffles Place Flagship — Pre-Launch Crisis Huddle (All Leads)',
        description: 'Final sign-off on Kiosk Step 2 UX, 28-seat chope & laptop policy, 9am SFA inspection SOP, and GrabFood 32% commission.',
      },
      {
        id: 'seed-bath-sanitization-prep',
        dtstart: `${tomorrow}T063000`,
        dtend: `${tomorrow}T073000`,
        summary: 'Opening Crew — 63°C Sous-Vide Egg Bath Calibration & Kaya Toast Prep',
        description: 'Pre-heat sous-vide holding tank to 63.0°C and log initial probe check before 8am doors open.',
      },
      {
        id: 'seed-straits-times-press',
        dtstart: `${tomorrow}T080000`,
        dtend: `${tomorrow}T084500`,
        summary: 'Straits Times Food Desk — Flagship Ribbon-Cutting & Tasting',
        description: 'Raffles Place #B1-14 storefront ribbon-cutting and traditional Set A kaya toast tasting.',
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
      {
        id: 'seed-kaya-delivery',
        dtstart: `${dPlus2}T070000`,
        dtend: `${dPlus2}T074500`,
        summary: 'Pandan Kaya & Hainanese Loaf Restock (Central Kitchen)',
        description: 'Morning delivery of 40kg house pandan kaya and 180 thick-cut loaves for CBD week.',
      },
      {
        id: 'seed-cbd-catering-review',
        dtstart: `${dPlus3}T150000`,
        dtend: `${dPlus3}T160000`,
        summary: 'CBD Corporate Platter & GrabFood Margin Review',
        description: 'Compare 5-set corporate bundle orders vs QR express self-pickup volume after Day 3.',
      },
      {
        id: 'seed-weekly-roaster-cupping',
        dtstart: `${dPlus5}T143000`,
        dtend: `${dPlus5}T153000`,
        summary: 'Liberica & Robusta Butter-Roast QC Cupping (Uncle Lim & Mei)',
        description: 'Check 80/20 Nanyang roast profile and sock-brew extraction yield across outlets.',
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
