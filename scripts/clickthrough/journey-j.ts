import type { Page } from 'playwright';
import {
  createMeeting,
  enterOwnRoom,
  launch,
  Run,
  speakLine,
  signedInPerson,
  stamp,
  BASE,
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

const JOURNEY = 'j';

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = stamp();
  try {
    const a = await signedInPerson(browser, run, { name: `Alpha Owner ${suffix}`, email: `owner-ja-${suffix}@clickthrough.test` });
    const b = await signedInPerson(browser, run, { name: `Beta Owner ${suffix}`, email: `owner-jb-${suffix}@clickthrough.test` });
    const titleA = `Alpha room ${suffix}`;
    const titleB = `Beta room ${suffix}`;
    const lineA = `Alpha secret zebra ${suffix}`;
    const lineB = `Beta secret walrus ${suffix}`;
    let linkA = '';
    let linkB = '';
    await step(run, a.page, 'alpha room', async () => {
      linkA = await createMeeting(a.page, titleA);
      await enterOwnRoom(a.page, linkA);
    });
    await step(run, b.page, 'beta room', async () => {
      linkB = await createMeeting(b.page, titleB);
      await enterOwnRoom(b.page, linkB);
    });
    if (linkA === '' || linkB === '') return;
    await step(run, a.page, 'type both', async () => {
      await speakLine(a.page, lineA);
      await speakLine(a.page, 'I will send the supplier the updated order by Friday.');
      await speakLine(b.page, lineB);
      await a.page.getByText(lineA).first().waitFor({ state: 'attached', timeout: 25_000 });
      await b.page.getByText(lineB).first().waitFor({ state: 'attached', timeout: 25_000 });
      await a.page.waitForTimeout(8_000);
      const ta = await bodyText(a.page);
      const tb = await bodyText(b.page);
      const shot = await run.shot(a.page, 'alpha-live');
      await run.shot(b.page, 'beta-live');
      if (ta.includes('walrus') || ta.includes(titleB)) run.finding('ERROR', 'live isolation', 'Alpha room shows Beta content', shot);
      else if (tb.includes('zebra') || tb.includes(titleA) || tb.includes('supplier the updated order')) run.finding('ERROR', 'live isolation', 'Beta room shows Alpha content', shot);
      else run.pass(`Live rooms are isolated: no cross lines or titles (${shot}).`);
    });
    await step(run, a.page, 'end both', async () => {
      for (const p of [a.page, b.page]) {
        await p.getByRole('button', { name: 'End for everyone' }).click();
        await p.getByRole('button', { name: 'End the meeting' }).click();
        await p.getByText(/meeting has ended|Meeting ended/i).first().waitFor({ timeout: 30_000 });
      }
      run.pass('Both meetings ended.');
    });
    for (const [label, p, title, mine, other, otherTitle] of [
      ['alpha', a.page, titleA, 'zebra', 'walrus', titleB],
      ['beta', b.page, titleB, 'walrus', 'zebra', titleA],
    ] as const) {
      await step(run, p, `minutes ${label}`, async () => {
        const wsId = await p.evaluate(async () => {
          const r = await fetch('/api/workspaces');
          const l = (await r.json()) as Array<{ id: string; kind: string }>;
          return l.find((w) => w.kind === 'personal')?.id ?? '';
        });
        await p.goto(`${BASE}/workspaces/${encodeURIComponent(wsId)}`);
        await p.getByText(title).first().waitFor({ timeout: 30_000 });
        const list = await bodyText(p);
        await p.getByRole('link', { name: 'Open', exact: true }).first().click();
        await p.getByRole('heading', { name: title }).waitFor({ timeout: 20_000 });
        let body = '';
        const end = Date.now() + 90_000;
        while (Date.now() < end) {
          body = await p.locator('main').innerText().catch(() => '');
          if (body.includes(mine)) break;
          await p.waitForTimeout(3_000);
        }
        const shot = await run.shot(p, `minutes-${label}`);
        if (!body.includes(mine)) run.finding('ERROR', `minutes ${label}`, 'own line missing from minutes', shot);
        else if (body.includes(other) || list.includes(otherTitle)) run.finding('ERROR', `minutes ${label}`, 'other meeting content leaked', shot);
        else run.pass(`${label} minutes hold only their own meeting (${shot}).`);
      });
    }
  } finally {
    run.save();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
