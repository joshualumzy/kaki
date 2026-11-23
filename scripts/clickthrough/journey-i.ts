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
  BASE,
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

const JOURNEY = 'i';

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = stamp();
  const ownerName = `Leaver Owner ${suffix}`;
  const guestName = `Stayer Guest ${suffix}`;
  try {
    const owner = await signedInPerson(browser, run, { name: ownerName, email: `owner-i-${suffix}@clickthrough.test` });
    const page = owner.page;
    let link = '';
    await step(run, page, 'owner room', async () => {
      link = await createMeeting(page, `Owner leaves ${suffix}`);
      await enterOwnRoom(page, link);
      await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
    });
    if (link === '') return;
    const invite = await inviteLink(page);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const guest = await guestPerson(browser, run);
    await step(run, guest.page, 'guest joins', async () => { await joinAsGuest(guest.page, invite, guestName); });
    const before = `Before owner left ${suffix}`;
    const during = `Guest while owner away ${suffix}`;
    const after = `After owner returned ${suffix}`;
    await step(run, page, 'line before', async () => {
      await speakLine(page, before);
      await guest.page.getByText(before).first().waitFor({ state: 'attached', timeout: 25_000 });
    });
    await step(run, page, 'owner leaves', async () => {
      await page.getByRole('button', { name: 'Leave', exact: true }).click();
      await page.getByText('You left the meeting').waitFor({ timeout: 20_000 });
      run.pass(`Owner left without ending (${await run.shot(page, 'owner-left')}).`);
    });
    await step(run, guest.page, 'guest sees owner gone', async () => {
      await guest.page.waitForTimeout(5_000);
      const text = await bodyText(guest.page);
      const shot = await run.shot(guest.page, 'guest-owner-away');
      if (/has ended|You left/i.test(text)) run.finding('ERROR', 'guest while owner away', `meeting wrongly looks over: "${text.slice(0, 200)}"`, shot);
      else {
        run.pass(`Guest still in the room while the owner is away (${shot}).`);
        await speakLine(guest.page, during);
        await guest.page.getByText(during).first().waitFor({ state: 'attached', timeout: 20_000 });
        run.pass('Guest can still speak while the owner is away.');
      }
    });
    await step(run, page, 'owner rejoins', async () => {
      await page.getByRole('button', { name: 'Rejoin', exact: true }).click();
      await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      await page.getByText(before).first().waitFor({ state: 'attached', timeout: 25_000 });
      await speakLine(page, after);
      await page.getByText(after).first().waitFor({ state: 'attached', timeout: 25_000 });
      run.pass(`Owner rejoined, sees earlier lines and can speak again (${await run.shot(page, 'owner-rejoined')}).`);
    });
    await step(run, page, 'owner ends', async () => {
      const endBtn = page.getByRole('button', { name: 'End for everyone' });
      if (!(await endBtn.isVisible().catch(() => false))) {
        run.finding('DEAD-END', 'owner after rejoin', 'End for everyone is not offered after rejoining', await run.shot(page, 'no-end'));
        return;
      }
      await endBtn.click();
      await page.getByRole('button', { name: 'End the meeting' }).click();
      await page.getByText(/meeting has ended|Meeting ended/i).first().waitFor({ timeout: 30_000 });
      run.pass('Owner ended the meeting after rejoining.');
    });
    await step(run, page, 'minutes', async () => {
      const id = link.split('/m/')[1] ?? '';
      let body = '';
      const end = Date.now() + 90_000;
      let url = '';
      const wsId = await page.evaluate(async () => {
        const r = await fetch('/api/workspaces');
        const l = (await r.json()) as Array<{ id: string; kind: string }>;
        return l.find((w) => w.kind === 'personal')?.id ?? '';
      });
      url = `${BASE}/workspaces/${encodeURIComponent(wsId)}`;
      await page.goto(url);
      await page.getByText(`Owner leaves ${suffix}`).first().waitFor({ timeout: 30_000 });
      await page.getByRole('link', { name: 'Open', exact: true }).first().click();
      await page.getByRole('heading', { name: `Owner leaves ${suffix}` }).waitFor({ timeout: 20_000 });
      while (Date.now() < end) {
        body = await page.locator('main').innerText().catch(() => '');
        if (body.includes(before) && body.includes(after)) break;
        await page.waitForTimeout(3_000);
      }
      const shot = await run.shot(page, 'minutes');
      void id;
      const missing = [before, during, after].filter((l) => !body.includes(l));
      if (missing.length > 0) run.finding('ERROR', 'minutes', `minutes miss: ${missing.join(' | ')}`, shot);
      else run.pass(`Minutes hold lines from before, during and after the owner's absence (${shot}).`);
    });
    await guest.context.close();
  } finally {
    run.save();
    await closeBrowser(browser);
  }
}

void withJourneyLock(JOURNEY, main).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
