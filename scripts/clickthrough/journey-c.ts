import type { Page } from 'playwright';
import {
  BASE,
  createMeeting,
  enterOwnRoom,
  launch,
  Run,
  sendTyped,
  signedInPerson,
  stamp,
} from './lib';

const JOURNEY = 'c';
const SAMPLE_ID = 'sample-nanyang-kopi';

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
  const suffix = stamp();
  const title = `Sample to-do clickthrough ${suffix}`;

  try {
    const owner = await signedInPerson(browser, run, {
      name: `Owner Three ${suffix}`,
      email: `owner3-${suffix}@clickthrough.test`,
    });
    const page = owner.page;

    await step(run, page, 'sample workspace in picker', async () => {
      await page.goto(`${BASE}/new`);
      await page.locator('#new-meeting-workspace').waitFor({ timeout: 20_000 });
      const options = await page.locator('#new-meeting-workspace option').allInnerTexts();
      const hasSample = options.some((option) => /Nanyang Kopi/.test(option));
      await page.locator('#new-meeting-workspace').selectOption(SAMPLE_ID);
      await page.waitForTimeout(1_000);
      const shot = await run.shot(page, 'sample-selected-on-new');
      if (!hasSample) {
        run.finding('ERROR', '/new workspace picker', 'the Nanyang Kopi sample is not offered in the workspace picker', shot);
        return;
      }
      const titleVisible = await page.locator('#new-meeting-title').isVisible().catch(() => false);
      const samplePanel = page.getByText('The sample workspace is for practice');
      const panelVisible = await samplePanel.isVisible().catch(() => false);
      if (!titleVisible && panelVisible) {
        run.finding(
          'DEAD-END',
          '/new with the Nanyang Kopi sample selected',
          'selecting the sample replaces the whole form with a practice link, so a meeting cannot be created in the sample workspace (the journey expected one); nothing explains why the form vanished',
          shot,
        );
        run.pass(`The sample is offered in the picker and the app offers a practice meeting instead (${shot}).`);
      } else if (titleVisible) {
        run.pass(`The sample workspace can be chosen without losing the title field (${shot}).`);
      }
    });

    let link = '';
    await step(run, page, 'fallback meeting', async () => {
      link = await createMeeting(page, title);
      const shot = await run.shot(page, 'personal-meeting-created');
      run.note(`Because the sample workspace cannot take a meeting, the to-do test continued in My workspace (${shot}).`);
    });
    if (link === '') return;

    let roomReady = false;
    await step(run, page, 'room and start', async () => {
      await enterOwnRoom(page, link);
      const overlay = page.getByRole('region', { name: 'Waiting for the meeting to start' });
      roomReady = !(await overlay.isVisible().catch(() => false));
      const shot = await run.shot(page, 'to-do-room-started');
      if (roomReady) run.pass(`Meeting in My workspace reaches the room (${shot}).`);
      else {
        const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 220);
        run.finding('ERROR', '/m/:id/room before the to-do test', `the meeting did not start: "${body}"`, shot);
      }
    });

    const line = 'Sam, please send the supplier the updated order by Friday.';
    await step(run, page, 'type the to-do line', async () => {
      if (!roomReady) return;
      await sendTyped(page, line);
      await page.getByText(line).first().waitFor({ timeout: 20_000 });
      const shot = await run.shot(page, 'to-do-line-typed');
      run.pass(`The to-do line can be typed into the meeting (${shot}).`);
    });

    await step(run, page, 'wait for to-do card', async () => {
      if (!roomReady) return;
      const started = Date.now();
      let found = '';
      let shot = '';
      while (Date.now() - started < 90_000) {
        const body = await page.locator('body').innerText().catch(() => '');
        if (/Do it for me|Let Kaki do it|Accept · I'll do it|Accept · I’ll do it/i.test(body)) {
          found = 'action';
          break;
        }
        if (/supplier/i.test(body) && /(to-?do|action|task|Sam)/i.test(body)) {
          found = 'card';
          break;
        }
        await page.waitForTimeout(5_000);
      }
      shot = await run.shot(page, 'to-do-wait-result');
      const body = await page.locator('body').innerText().catch(() => '');
      const seconds = Math.round((Date.now() - started) / 1000);
      if (found === '') {
        run.finding(
          'SLOW',
          '/m/:id/room to-do card',
          `no to-do card or action button appeared within 90 s of typing the line (waited ${seconds} s)`,
          shot,
        );
        return;
      }
      run.pass(`A to-do card appeared after about ${seconds} s (${shot}).`);
      const action = page.getByRole('button', { name: /Do it for me/i }).first();
      if (await action.isVisible().catch(() => false)) {
        const label = (await action.innerText()).trim();
        const beforeShot = await run.shot(page, 'action-button-visible');
        await action.click();
        run.pass(`The "${label}" action was available and was pressed (${beforeShot}).`);
        const end = Date.now() + 60_000;
        let outcome = '';
        while (Date.now() < end) {
          const after = await page.locator('body').innerText().catch(() => '');
          if (/drafted|draft ready|Draft Ready|sent|published|failed|could not|error|not sent/i.test(after)) {
            outcome = after.match(/[^\n]*(drafted|draft ready|Draft Ready|sent|published|failed|could not|error|not sent)[^\n]*/i)?.[0] ?? '';
            break;
          }
          await page.waitForTimeout(3_000);
        }
        const afterShot = await run.shot(page, 'action-result');
        if (outcome === '') {
          run.finding('SLOW', '/m/:id/room action button', 'nothing visible happened within 60 s of pressing the action', afterShot);
        } else {
          run.pass(`Pressing the action showed: "${outcome.trim().slice(0, 140)}" (${afterShot}).`);
        }
      } else {
        const bodyText = body.replace(/\s+/g, ' ');
        const onlyOwner = /Only .* can send this/i.test(bodyText);
        run.finding(
          'CONFUSING',
          '/m/:id/room to-do card',
          onlyOwner
            ? 'the to-do card is addressed to Sam, so the meeting owner only sees "Only Sam can send this" and has no action button'
            : 'a to-do card appeared, but there was no action button for it',
          shot,
        );
      }
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
