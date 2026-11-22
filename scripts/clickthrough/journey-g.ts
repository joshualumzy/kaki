import type { Page } from 'playwright';
import {
  createMeeting,
  enterOwnRoom,
  launch,
  Run,
  sendTyped,
  signedInPerson,
  stamp,
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

const JOURNEY = 'g';
const SAMPLE_ID = 'sample-nanyang-kopi';

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = stamp();
  try {
    const owner = await signedInPerson(browser, run, { name: `Notes Owner ${suffix}`, email: `owner-g-${suffix}@clickthrough.test` });
    const page = owner.page;
    let link = '';
    await step(run, page, 'meeting and lines', async () => {
      link = await createMeeting(page, `Send notes ${suffix}`, { workspaceId: SAMPLE_ID });
      await enterOwnRoom(page, link);
      await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      await sendTyped(page, `We agreed to move the launch to Friday (${suffix}).`);
      await sendTyped(page, 'I will send the supplier the updated order by Friday.');
      await page.getByText('updated order by Friday').first().waitFor({ state: 'attached', timeout: 20_000 });
      run.pass(`Owner is in a real meeting and typed two lines (${await run.shot(page, 'typed')}).`);
    });
    if (link === '') return;

    await step(run, page, 'end the meeting', async () => {
      await page.getByRole('button', { name: 'End for everyone' }).click();
      await page.getByRole('button', { name: 'End the meeting' }).click();
      await page.getByText(/meeting has ended|Meeting ended/i).first().waitFor({ timeout: 30_000 });
      run.pass(`Owner ended the meeting (${await run.shot(page, 'ended')}).`);
    });

    await step(run, page, 'send-notes cards', async () => {
      const card = page.locator('.kd-task-card', { hasText: /notes/i }).first();
      const shown = await card.waitFor({ timeout: 90_000 }).then(() => true).catch(() => false);
      const shot = await run.shot(page, 'after-end-cards');
      if (!shown) {
        run.finding('DEAD-END', '/m/:id/room after End', `no send-the-notes card on the ended screen: "${(await bodyText(page)).slice(0, 300)}"`, shot);
        return;
      }
      run.pass(`A send-the-notes card is shown: "${(await card.innerText()).replace(/\s+/g, ' ').slice(0, 120)}" (${shot}).`);
      const approve = page.getByRole('button', { name: /Approve/ }).first();
      if (!(await approve.waitFor({ timeout: 60_000 }).then(() => true).catch(() => false))) {
        run.finding('DEAD-END', 'send-notes card', 'card has no Approve button', await run.shot(page, 'no-approve'));
        return;
      }
      await approve.click();
      const end = Date.now() + 45_000;
      let answer = '';
      while (Date.now() < end) {
        const text = await bodyText(page);
        const m = /[^.]*(draft-only|nothing was sent|not sent|Sent)[^.]*/i.exec(text);
        if (m !== null) { answer = m[0].trim(); break; }
        await page.waitForTimeout(2_000);
      }
      const after = await run.shot(page, 'after-approve');
      if (answer === '') run.finding('DEAD-END', 'send-notes approve', 'after Approve nothing says sent or draft-only', after);
      else run.pass(`Approving answered: "${answer.slice(0, 160)}" (${after}).`);
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
