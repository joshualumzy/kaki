import type { Page } from 'playwright';
import {
  BASE,
  createMeeting,
  enterOwnRoom,
  launch,
  Run,
  speakLine,
  signedInPerson,
  stamp,
  withJourneyLock,
  closeBrowser,
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
  const ownerName = `Owner Three ${suffix}`;
  const title = `Sample to-do clickthrough ${suffix}`;

  try {
    const owner = await signedInPerson(browser, run, {
      name: ownerName,
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
    await step(run, page, 'meeting in the sample workspace', async () => {
      link = await createMeeting(page, title, { workspaceId: SAMPLE_ID });
      const shot = await run.shot(page, 'sample-meeting-created');
      run.pass(`A meeting can be created in the Nanyang Kopi sample workspace (${shot}).`);
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

    const line = "I'll send the supplier the updated order by Friday.";
    await step(run, page, 'speak the to-do line', async () => {
      if (!roomReady) return;
      await speakLine(page, line);
      await page.getByText(line).first().waitFor({ timeout: 20_000 });
      const shot = await run.shot(page, 'to-do-line-spoken');
      run.pass(`The to-do line can be spoken into the meeting (${shot}).`);
    });

    await step(run, page, 'dispatch the to-do and press its button', async () => {
      if (!roomReady) return;
      const started = Date.now();
      const card = page.locator('.kd-task-card').first();
      const cardShown = await card.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
      const cardShot = await run.shot(page, 'to-do-card');
      const seconds = Math.round((Date.now() - started) / 1000);
      if (!cardShown) {
        run.finding(
          'SLOW',
          '/m/:id/room to-do card',
          `no to-do card appeared within 90 s of speaking the line (waited ${seconds} s)`,
          cardShot,
        );
        return;
      }
      const title = (await card.locator('b').first().innerText().catch(() => '')).trim();
      run.pass(`A to-do card appeared after about ${seconds} s: "${title.slice(0, 120)}" (${cardShot}).`);

      // A real meeting has no AI colleague to pick the card up: the owner dispatches it, then acts.
      const picker = card.locator('select').first();
      if (await picker.isVisible().catch(() => false)) {
        const labels = await picker.locator('option').evaluateAll((options) =>
          options.map((option) => ({ value: (option as HTMLOptionElement).value, label: option.textContent?.trim() ?? '' })),
        );
        const mine = labels.find((option) => option.label.includes(ownerName)) ?? labels[labels.length - 1] ?? labels[0];
        if (mine !== undefined) await picker.selectOption(mine.value);
        await card.getByRole('button', { name: 'Dispatch', exact: true }).click();
      }

      const action = page
        .getByRole('button', { name: /Do it for me|Accept · Let Kaki do it|Accept · I[’']ll do it/ })
        .first();
      const actionShown = await action.waitFor({ timeout: 30_000 }).then(() => true).catch(() => false);
      if (!actionShown) {
        run.finding('CONFUSING', '/m/:id/room to-do card', 'a to-do card appeared, but there was no action button for it', cardShot);
        return;
      }
      const label = (await action.innerText()).trim();
      const beforeShot = await run.shot(page, 'action-button-visible');
      await action.click();
      run.pass(`The "${label}" action was available and was pressed (${beforeShot}).`);

      // Kaki drafts first; the draft is what proves the button works without anything being sent.
      const draft = page.locator('.draft-body').first();
      const drafted = await draft.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
      const draftShot = await run.shot(page, 'action-draft');
      if (!drafted) {
        const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
        run.finding('SLOW', '/m/:id/room action button', `no draft appeared within 90 s of pressing the action; page said "${body.slice(0, 200)}"`, draftShot);
        return;
      }
      run.pass(`Kaki produced a reviewable draft instead of sending it (${draftShot}).`);

      const approve = page.getByRole('button', { name: /Approve & publish|Approve &amp; publish/ }).first();
      const canApprove = await approve.isVisible().catch(() => false);
      run.pass(`The draft can be reviewed before sending (${draftShot}).`);
      if (canApprove) {
        await approve.click();
        const end = Date.now() + 45_000;
        let published = '';
        let draftOnly = '';
        while (Date.now() < end) {
          const text = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
          const liveLink = await page.locator('.artifact-link').first().isVisible().catch(() => false);
          const summary = /[^.]*(?:Published to|Issue created in Gitea|Page published to Team Wiki|Email sent to|Meeting scheduled on Team Calendar|Published live)[^.]*/.exec(text);
          if (liveLink || summary !== null) {
            published = summary?.[0].trim() ?? 'a live artifact link';
            break;
          }
          const refusal = /[^.]*Draft-only mode[^.]*nothing was sent[^.]*/.exec(text);
          if (refusal !== null) {
            draftOnly = refusal[0].trim();
            break;
          }
          await page.waitForTimeout(3_000);
        }
        const afterShot = await run.shot(page, 'action-result');
        if (published !== '') {
          run.pass(`Approving published the to-do for real: "${published.slice(0, 160)}" (${afterShot}).`);
        } else if (draftOnly !== '') {
          run.pass(`The stack is in draft-only mode, so approving sent nothing: "${draftOnly.slice(0, 160)}" (${afterShot}).`);
        } else {
          run.finding('CONFUSING', '/m/:id/room action publish', 'after Approve & publish the card never said the to-do was published, and gave no draft-only refusal', afterShot);
        }
      }
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
