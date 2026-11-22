import type { Page } from 'playwright';
import {
  createMeeting,
  guestPerson,
  inviteLink,
  launch,
  Run,
  signedInPerson,
  stamp,
  tomorrow,
} from './lib';

const JOURNEY = 'b';

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
  const ownerName = `Owner Two ${suffix}`;
  const guestName = `Guest Two ${suffix}`;
  const title = `Scheduled clickthrough ${suffix}`;

  try {
    const owner = await signedInPerson(browser, run, { name: ownerName, email: `owner2-${suffix}@clickthrough.test` });
    const guest = await guestPerson(browser, run, {
      expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
    });

    let link = '';
    await step(run, owner.page, 'schedule meeting', async () => {
      link = await createMeeting(owner.page, title, { scheduleAt: { date: tomorrow(), time: '10:00' } });
      const shot = await run.shot(owner.page, 'scheduled-created');
      run.pass(`Schedule for later creates a meeting with an invite link (${shot}).`);
    });
    if (link === '') return;

    await step(run, guest.page, 'plain created link as a guest', async () => {
      const other = await guestPerson(browser, run, {
        expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
      });
      await other.page.goto(link);
      await other.page.getByText('You are invited').waitFor({ timeout: 15_000 });
      await other.page.getByLabel('Your name').fill('Link Test');
      await other.page.getByRole('button', { name: 'Join meeting' }).click();
      await other.page.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 });
      await other.page.waitForTimeout(6_000);
      const shot = await run.shot(other.page, 'plain-link-code-wall');
      const body = (await other.page.locator('body').innerText()).replace(/\s+/g, ' ');
      if (/Enter the meeting code|MEETING CODE/i.test(body)) {
        run.finding(
          'CONFUSING',
          '/new -> "Share this link with the people joining" -> guest opens it',
          'the link on the meeting-ready card has no ?code=, so the guest joins and is stopped by "Enter the meeting code" with no hint of what a code is or that a proper invite exists',
          shot,
        );
      } else {
        run.pass(`A guest joining from the plain meeting-ready link gets in (${shot}).`);
      }
      await other.context.close();
    });

    await step(run, owner.page, 'owner in lobby', async () => {
      await owner.page.goto(link);
      const join = owner.page.getByRole('button', { name: 'Join meeting' });
      await join.waitFor({ timeout: 20_000 }).catch(() => undefined);
      if (await join.isVisible().catch(() => false)) await join.click();
      await owner.page.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 });
      await owner.page.getByRole('button', { name: 'Start the meeting' }).waitFor({ timeout: 60_000 });
      const shot = await run.shot(owner.page, 'owner-lobby');
      run.pass(`The owner can sit in the lobby of a scheduled meeting (${shot}).`);
    });

    let invite = '';
    await step(run, owner.page, 'owner invite link', async () => {
      invite = await inviteLink(owner.page);
      const shot = await run.shot(owner.page, 'owner-invite-dialog');
      run.pass(`The owner copies an invite link from the room (${shot}).`);
      await owner.page.getByRole('button', { name: 'Invite', exact: true }).click();
    });
    if (invite === '') return;

    await step(run, guest.page, 'guest waits before start', async () => {
      await guest.page.goto(invite);
      await guest.page.getByText('You are invited').waitFor({ timeout: 15_000 });
      const planned = guest.page.getByText(/This meeting is planned for/);
      const joinShot = await run.shot(guest.page, 'guest-before-start-join-page');
      if (await planned.isVisible().catch(() => false)) {
        run.pass(`The join page says the meeting is planned for later and that you can join early (${joinShot}).`);
      } else {
        run.finding('CONFUSING', '/m/:id before start', 'join page does not mention the planned time', joinShot);
      }
      await guest.page.getByLabel('Your name').fill(guestName);
      await guest.page.getByRole('button', { name: 'Join meeting' }).click();
      await guest.page.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 });
      await guest.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      await guest.page.getByText(/Waiting for .* to start/).waitFor({ timeout: 20_000 });
      const roomShot = await run.shot(guest.page, 'guest-waiting-for-owner');
      run.pass(`Guest waits in the room with a clear "Waiting for ${ownerName} to start" message (${roomShot}).`);
    });

    await step(run, owner.page, 'owner starts', async () => {
      await owner.page.getByRole('button', { name: 'Start the meeting' }).click();
      await owner.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 30_000 });
      const shot = await run.shot(owner.page, 'owner-started-scheduled');
      run.pass(`The owner can start the scheduled meeting early (${shot}).`);
    });

    await step(run, guest.page, 'guest gets in after start', async () => {
      await guest.page.getByText(/Waiting for .* to start/).waitFor({ state: 'hidden', timeout: 40_000 });
      await guest.page.getByRole('button', { name: 'Type', exact: true }).waitFor({ timeout: 15_000 });
      await guest.page.getByRole('button', { name: 'Type', exact: true }).click();
      const box = guest.page.getByLabel('Type to the meeting');
      await box.fill(`Guest made it into the scheduled meeting ${suffix}`);
      await box.press('Enter');
      await guest.page.getByText(`Guest made it into the scheduled meeting ${suffix}`).first().waitFor({ timeout: 20_000 });
      const shot = await run.shot(guest.page, 'guest-in-after-start');
      run.pass(`After the owner starts, the guest's waiting overlay goes away and the guest can type (${shot}).`);
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
