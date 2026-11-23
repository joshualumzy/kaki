import type { Page } from 'playwright';
import {
  createMeeting,
  enterOwnRoom,
  guestPerson,
  inviteLink,
  joinAsGuest,
  launch,
  Run,
  speakLine,
  signedInPerson,
  stamp,
  withJourneyLock,
  closeBrowser,
} from './lib';

async function step(run: Run, page: Page, where: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const shot = await run.shot(page, `failed-${where.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => '');
    run.finding('ERROR', where, `step threw: ${error instanceof Error ? error.message : String(error)}`, shot);
  }
}

async function bodyText(page: Page): Promise<string> {
  return (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
}

const JOURNEY = 'h';

async function peopleList(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: /People/ }).click();
  const dialog = page.getByRole('dialog', { name: 'People in the meeting' });
  await dialog.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(1_500);
  const items = await dialog.locator('li').allInnerTexts();
  await page.getByRole('button', { name: /People/ }).click();
  return items.map((item) => item.replace(/\s+/g, ' ').trim());
}

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = stamp();
  const ownerName = `Trio Owner ${suffix}`;
  const twin = `Sam Twin ${suffix}`;
  try {
    const owner = await signedInPerson(browser, run, { name: ownerName, email: `owner-h-${suffix}@clickthrough.test` });
    const page = owner.page;
    let link = '';
    await step(run, page, 'owner room', async () => {
      link = await createMeeting(page, `Trio ${suffix}`);
      await enterOwnRoom(page, link);
      await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
    });
    if (link === '') return;
    const invite = await inviteLink(page);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const g1 = await guestPerson(browser, run);
    const g2 = await guestPerson(browser, run);
    await step(run, g1.page, 'guest 1 joins', async () => { await joinAsGuest(g1.page, invite, twin); });
    await step(run, g2.page, 'guest 2 joins', async () => { await joinAsGuest(g2.page, invite, twin); });
    const lines = { o: `Owner says alpha ${suffix}`, a: `First twin says bravo ${suffix}`, b: `Second twin says charlie ${suffix}` };
    await step(run, page, 'everyone speaks', async () => {
      await speakLine(page, lines.o);
      await speakLine(g1.page, lines.a);
      await speakLine(g2.page, lines.b);
      for (const p of [page, g1.page, g2.page]) {
        for (const l of Object.values(lines)) await p.getByText(l).first().waitFor({ state: 'attached', timeout: 25_000 });
      }
      run.pass(`All three lines reach all three people (${await run.shot(page, 'owner-all-lines')}).`);
    });
    const check = async (label: string, p: Page): Promise<void> => {
      const list = await peopleList(p);
      const shot = await run.shot(p, `people-${label}`);
      const twins = list.filter((x) => x.includes(twin)).length;
      const hasOwner = list.some((x) => x.includes(ownerName));
      if (list.length !== 3 || twins !== 2 || !hasOwner) {
        run.finding('ERROR', `people list (${label})`, `expected owner + 2 twins, saw: ${JSON.stringify(list)}`, shot);
      } else run.pass(`${label} sees owner and both same-named guests (${shot}). List: ${JSON.stringify(list)}`);
    };
    await step(run, page, 'people owner', () => check('owner', page));
    await step(run, g1.page, 'people g1', () => check('guest1', g1.page));
    await step(run, g2.page, 'people g2', () => check('guest2', g2.page));
    for (const [label, p, mine, other] of [['owner', page, lines.o, lines.a], ['guest1', g1.page, lines.a, lines.b], ['guest2', g2.page, lines.b, lines.a]] as const) {
      await step(run, p, `refresh ${label}`, async () => {
        await p.reload();
        await p.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
        const shot = await run.shot(p, `refreshed-${label}`);
        const text = await bodyText(p);
        if (/You left|has ended|Join meeting/i.test(text) && !/Leave/.test(text)) run.finding('ERROR', `refresh ${label}`, 'lost seat', shot);
        await p.getByText(mine).first().waitFor({ state: 'attached', timeout: 25_000 });
        await p.getByText(other).first().waitFor({ state: 'attached', timeout: 25_000 });
        await speakLine(p, `After refresh ${label} ${suffix}`);
        await page.getByText(`After refresh ${label} ${suffix}`).first().waitFor({ state: 'attached', timeout: 25_000 });
        run.pass(`${label} refreshed, kept their seat, history and can still speak (${shot}).`);
      });
    }
    await step(run, page, 'people after refresh', async () => {
      // A refreshed seat must never be listed twice, not even briefly: poll for a while and report how long.
      const started = Date.now();
      let list: string[] = [];
      while (Date.now() - started < 45_000) {
        list = await peopleList(page);
        if (list.length === 3) break;
        await page.waitForTimeout(2_000);
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      if (list.length !== 3) run.finding('ERROR', 'people after refresh', `still ${list.length} entries after ${seconds} s: ${JSON.stringify(list)}`, await run.shot(page, 'people-dup'));
      else if (seconds > 4) run.finding('CONFUSING', 'people after refresh', `a refreshed person was listed twice for about ${seconds} s`);
      else run.pass('People list is exact right after everyone refreshed.');
    });
    await g1.context.close();
    await g2.context.close();
  } finally {
    run.save();
    await closeBrowser(browser);
  }
}

void withJourneyLock(JOURNEY, main).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
