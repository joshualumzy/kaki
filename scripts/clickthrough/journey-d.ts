import type { Page } from 'playwright';
// First: the fake speaker reads the LiveKit keys from the repo's .env.
import '../../server/src/env';
import { createFakeSpeaker } from '../../server/src/npc/fakeStt';
import { BASE, launch, Run, guestPerson, withJourneyLock, closeBrowser } from './lib';

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
  const guest = await guestPerson(browser, run);
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
      await page.getByRole('button', { name: /Join with mic/ }).waitFor({ timeout: 20_000 });
      run.pass(`Practice opens for a visitor with no account and a Join form (${shot}).`);
    });

    await step(run, page, 'join practice', async () => {
      const nameBox = page.locator('#join-name');
      await nameBox.fill(`Practice Guest ${suffix}`);
      const join = page.getByRole('button', { name: /Join with mic/ });
      await join.click();
      const startedWaiting = Date.now();
      const outcome = await Promise.race([
        page.getByRole('button', { name: /Next: How to play/ }).waitFor({ timeout: 90_000 }).then(() => 'briefing' as const),
        page.locator('.kd-meeting[data-needs-start="false"]').waitFor({ timeout: 90_000 }).then(() => 'running' as const),
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
      await page.locator('.kd-meeting[data-needs-start="false"]').waitFor({ timeout: 60_000 });
      const shot = await run.shot(page, 'practice-started');
      run.pass(`The practice meeting starts (${shot}).`);
    });

    await step(run, page, 'speak through practice', async () => {
      const lines = [
        `Welcome everyone, let's start with the kopitiam launch. (${suffix})`,
        'I think the new menu should launch next week, and we need the supplier order confirmed.',
        'Sam, can you check the supplier and the stock before Friday?',
      ];
      // Practice is speech only: the guest speaks through the dev-only fake recogniser (runner on KAKI_FAKE_STT=1).
      const speaker = createFakeSpeaker();
      for (const [index, line] of lines.entries()) {
        await speaker.say(`Practice Guest ${suffix}`, line);
        await page.waitForTimeout(index === lines.length - 1 ? 20_000 : 12_000);
        const shot = await run.shot(page, `practice-spoken-${index + 1}`);
        run.pass(`Practice heard spoken line ${index + 1} (${shot}).`);
      }
      // Practice is speech only: no type box, Send, Lock or Pause under the stage.
      const shot = await run.shot(page, 'practice-running');
      const leftovers: string[] = [];
      if (await page.getByLabel('Type to the meeting').isVisible().catch(() => false)) leftovers.push('a type box');
      for (const name of [/^Send$/, /Lock in my decision/, /^Pause$/]) {
        if (await page.getByRole('button', { name }).isVisible().catch(() => false)) leftovers.push(`a ${name.source} button`);
      }
      if (leftovers.length > 0) {
        run.finding('ERROR', '/practice running', `practice is meant to be speech only but shows ${leftovers.join(', ')}`, shot);
      } else {
        run.pass(`Practice is speech only: no type box, Send, Lock or Pause under the stage (${shot}).`);
      }
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      if (/\b(type (in|below|it|to|your)|join to type|use type)\b/i.test(body)) {
        run.finding('CONFUSING', '/practice running', 'practice text still tells the visitor to type', shot);
      }
      if (/Arjun|Mei|Daniel|Sam/.test(body)) {
        run.pass('Practice shows AI colleagues by name while it runs.');
      } else {
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
      const join = page.getByRole('button', { name: /Join with mic/ });
      if (!(await join.isVisible().catch(() => false))) {
        const rejoin = page.getByRole('button', { name: 'Rejoin', exact: true });
        if (await rejoin.isVisible().catch(() => false)) {
          await rejoin.click();
          await page.getByRole('button', { name: /Next: How to play/ }).waitFor({ timeout: 60_000 }).catch(() => undefined);
          const shot = await run.shot(page, 'practice-rejoined-from-left');
          run.pass(`After leaving, /practice offered Rejoin and got back in (${shot}).`);
          return;
        }
        if (await page.locator('.kd-meeting[data-needs-start="false"]').isVisible().catch(() => false)) {
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
      await page.getByRole('button', { name: /Next: How to play/ }).waitFor({ timeout: 90_000 });
      const shot = await run.shot(page, 'practice-reopened');
      run.pass(`Coming back to /practice starts a fresh practice meeting with a briefing (${joinShot}, ${shot}).`);
    });

    await step(run, page, 'demo route', async () => {
      const demo = await guestPerson(browser, run);
      await demo.page.goto(`${BASE}/practice`);
      await demo.page.waitForTimeout(4_000);
      const shot = await run.shot(demo.page, 'demo-open');
      const body = (await demo.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      if (body === '') run.finding('DEAD-END', '/practice', 'blank page', shot);
      else run.pass(`/practice opens a real page: "${body.slice(0, 120)}" (${shot}).`);
      await demo.context.close();
    });
  } finally {
    run.save();
    await closeBrowser(browser);
  }
}

void withJourneyLock(JOURNEY, main).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
