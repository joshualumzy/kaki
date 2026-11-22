import type { Page } from 'playwright';
import { BASE, launch, Run, guestPerson } from './lib';

const JOURNEY = 'd';

async function step(run: Run, page: Page, where: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const shot = await run.shot(page, `failed-${where.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => '');
    run.finding('ERROR', where, `step threw: ${error instanceof Error ? error.message : String(error)}`, shot);
  }
}

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = String(Date.now()).slice(-7);
  const guest = await guestPerson(browser, run, {
    expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
  });
  const page = guest.page;

  try {
    await step(run, page, 'practice join page', async () => {
      await page.goto(`${BASE}/practice`);
      await page.waitForTimeout(4_000);
      const shot = await run.shot(page, 'practice-open');
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      if (/sign in|Sign in with Google/i.test(body) && !/Join meeting/i.test(body)) {
        run.finding('DEAD-END', '/practice with no account', `practice asks for sign-in in this stack mode: "${body.slice(0, 200)}"`, shot);
        return;
      }
      await page.getByRole('button', { name: /Join to type|Join with mic/ }).waitFor({ timeout: 20_000 });
      run.pass(`Practice opens for a visitor with no account and a Join form (${shot}).`);
    });

    await step(run, page, 'join practice', async () => {
      const nameBox = page.locator('#join-name');
      await nameBox.fill(`Practice Guest ${suffix}`);
      const join = page.getByRole('button', { name: /Join to type|Join with mic/ });
      await join.click();
      const startedWaiting = Date.now();
      const outcome = await Promise.race([
        page.getByText('Before the meeting starts').waitFor({ timeout: 90_000 }).then(() => 'briefing' as const),
        page.getByLabel('Type to the meeting').waitFor({ timeout: 90_000 }).then(() => 'running' as const),
      ]).catch(() => 'none' as const);
      const waited = Date.now() - startedWaiting;
      const shot = await run.shot(page, 'practice-joined');
      if (outcome === 'none') {
        run.finding('ERROR', '/practice after joining', 'joining practice showed neither the briefing nor a usable room', shot);
        return;
      }
      if (waited > 10_000) {
        run.finding('SLOW', '/practice after joining', `the room took ${(waited / 1000).toFixed(0)} s to appear`);
      }
      run.pass(
        outcome === 'briefing'
          ? `Practice joins into its pre-meeting briefing (${shot}).`
          : `Practice is already running, and the guest joined its room directly (${shot}).`,
      );
    });

    await step(run, page, 'start practice', async () => {
      const next = page.getByRole('button', { name: /Next: How to play/ });
      if (await next.isVisible().catch(() => false)) {
        await next.click();
        const howToShot = await run.shot(page, 'practice-how-to-play');
        run.pass(`The practice briefing has a How to play step (${howToShot}).`);
      } else {
        run.note('The practice meeting was already started, so there was no how-to-play step to click.');
      }
      const start = page.getByRole('button', { name: 'Start the meeting' });
      if (await start.isVisible().catch(() => false)) await start.click();
      await page.getByLabel('Type to the meeting').waitFor({ timeout: 60_000 });
      const shot = await run.shot(page, 'practice-started');
      run.pass(`The practice meeting starts and shows a type box (${shot}).`);
    });

    await step(run, page, 'type through practice', async () => {
      const lines = [
        `Welcome everyone, let's start with the kopitiam launch. (${suffix})`,
        'I think the new menu should launch next week, and we need the supplier order confirmed.',
        'Sam, can you check the supplier and the stock before Friday?',
      ];
      for (const [index, line] of lines.entries()) {
        const box = page.getByLabel('Type to the meeting');
        await box.fill(line);
        await box.press('Enter');
        await page.waitForTimeout(index === lines.length - 1 ? 20_000 : 12_000);
        const shot = await run.shot(page, `practice-typed-${index + 1}`);
        run.pass(`Practice accepted typed line ${index + 1} (${shot}).`);
      }
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      if (/Arjun|Mei|Daniel|Sam/.test(body)) {
        run.pass('Practice shows AI colleagues by name while it runs.');
      } else {
        const shot = await run.shot(page, 'practice-no-names');
        run.finding('CONFUSING', '/practice running', 'no AI colleague name is visible in the practice meeting', shot);
      }
    });

    await step(run, page, 'leave practice', async () => {
      const leave = page.getByRole('button', { name: 'Leave', exact: true });
      const shotBefore = await run.shot(page, 'practice-before-leave');
      if (await leave.isVisible().catch(() => false)) {
        await leave.click();
        await page.getByText('You left the meeting').waitFor({ timeout: 20_000 });
        const shot = await run.shot(page, 'practice-left');
        run.pass(`Practice has a Leave button and a clear left screen (${shotBefore}, ${shot}).`);
      } else {
        run.finding(
          'DEAD-END',
          '/practice running',
          'there is no Leave button in a practice meeting; the only ways out are browser Back or closing the tab',
          shotBefore,
        );
        await page.goBack();
        await page.waitForTimeout(2_000);
        const shot = await run.shot(page, 'practice-after-back');
        run.pass(`Browser Back leaves practice and lands on ${page.url().replace(BASE, '')} (${shot}).`);
      }
    });

    await step(run, page, 'return to practice', async () => {
      await page.goto(`${BASE}/practice`);
      await page.waitForTimeout(8_000);
      const joinShot = await run.shot(page, 'practice-reopen-join');
      const join = page.getByRole('button', { name: /Join to type|Join with mic/ });
      if (!(await join.isVisible().catch(() => false))) {
        const rejoin = page.getByRole('button', { name: 'Rejoin', exact: true });
        if (await rejoin.isVisible().catch(() => false)) {
          await rejoin.click();
          await page.getByText('Before the meeting starts').waitFor({ timeout: 60_000 }).catch(() => undefined);
          const shot = await run.shot(page, 'practice-rejoined-from-left');
          run.pass(`After leaving, /practice offered Rejoin and got back in (${shot}).`);
          return;
        }
        if (await page.getByLabel('Type to the meeting').isVisible().catch(() => false)) {
          const shot = await run.shot(page, 'practice-reopened-running');
          run.pass(`After leaving, /practice returned to the running practice meeting (${shot}).`);
          return;
        }
        const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 240);
        run.finding('CONFUSING', '/practice after leaving', `reopening /practice showed neither the join form nor a room; it showed "${body}"`, joinShot);
        return;
      }
      const nameBox = page.locator('#join-name');
      await nameBox.fill(`Practice Guest ${suffix}`);
      await join.click();
      await page.getByText('Before the meeting starts').waitFor({ timeout: 90_000 });
      const shot = await run.shot(page, 'practice-reopened');
      run.pass(`Coming back to /practice starts a fresh practice meeting with a briefing (${joinShot}, ${shot}).`);
    });

    await step(run, page, 'demo route', async () => {
      const demo = await guestPerson(browser, run, {
        expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
      });
      await demo.page.goto(`${BASE}/demo`);
      await demo.page.waitForTimeout(4_000);
      const shot = await run.shot(demo.page, 'demo-open');
      const body = (await demo.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      if (body === '') run.finding('DEAD-END', '/demo', 'blank page', shot);
      else run.pass(`/demo opens a real page: "${body.slice(0, 120)}" (${shot}).`);
      await demo.context.close();
    });
  } finally {
    run.save();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
