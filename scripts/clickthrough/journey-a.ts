import type { Page } from 'playwright';
import {
  BASE,
  createMeeting,
  enterOwnRoom,
  guestPerson,
  inviteLink,
  launch,
  Run,
  speakLine,
  signedInPerson,
  stamp,
  workspaces,
} from './lib';

const JOURNEY = 'a';

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
  const ownerName = `Owner One ${suffix}`;
  const guestName = `Guest One ${suffix}`;
  let workspaceId = '';

  try {
    const anon = await guestPerson(browser, run);
    const anonPage = anon.page;

    await step(run, anonPage, 'landing', async () => {
      await anonPage.goto(BASE + '/');
      await anonPage.getByRole('link', { name: 'Sign in' }).waitFor({ timeout: 15_000 });
      const shot = await run.shot(anonPage, 'landing-signed-out');
      run.pass(`Landing renders signed out with a Sign in link (${shot}).`);
    });

    await step(run, anonPage, 'signin page', async () => {
      await anonPage.getByRole('link', { name: 'Sign in' }).click();
      await anonPage.getByRole('link', { name: /Sign in with Google/ }).waitFor({ timeout: 15_000 });
      const shot = await run.shot(anonPage, 'signin-page');
      run.pass(`Sign-in page renders with a Google button (${shot}).`);
      const href = await anonPage.getByRole('link', { name: /Sign in with Google/ }).getAttribute('href');
      if (href === null || !href.startsWith('/api/auth/google/start')) {
        run.finding('ERROR', '/signin', `Google button points at ${String(href)} instead of the server start route`, shot);
      }
      run.note('Google button was checked but not completed; real Google sign-in is unavailable in this stack.');
    });

    const owner = await signedInPerson(browser, run, {
      name: ownerName,
      email: `owner1-${suffix}@clickthrough.test`,
      expected: (status, url) => status === 400 && url.includes('/tools/mattermost/test'),
    });
    const ownerPage = owner.page;

    await step(run, ownerPage, 'workspace page', async () => {
      await ownerPage.goto(BASE + '/new');
      await ownerPage.locator('#new-meeting-title').waitFor({ timeout: 20_000 });
      const list = await workspaces(ownerPage);
      const personal = list.find((workspace) => workspace.kind === 'personal');
      if (personal === undefined) throw new Error('new user has no personal workspace');
      workspaceId = personal.id;
      await ownerPage.goto(`${BASE}/workspaces/${encodeURIComponent(personal.id)}`);
      await ownerPage.getByRole('heading', { name: 'My workspace' }).waitFor({ timeout: 20_000 });
      const shot = await run.shot(ownerPage, 'my-workspace');
      run.pass(`A fresh user has My workspace and its page loads (${shot}).`);
    });

    await step(run, ownerPage, 'tool test with wrong token', async () => {
      const tools = ownerPage.locator('section[aria-label="Tools"]');
      await tools.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await ownerPage.getByLabel('Mattermost URL').fill('http://localhost:8083');
      await ownerPage.getByLabel('Team').fill('kopitiam');
      await ownerPage.getByLabel('Channel').fill('kopitiam-launch');
      await ownerPage.getByLabel('Bot token').fill('wrong-token-clickthrough');
      const shotOpen = await run.shot(ownerPage, 'tool-form-open');
      await ownerPage.getByRole('button', { name: 'Test', exact: true }).click();
      const alert = ownerPage.getByRole('alert');
      await alert.waitFor({ timeout: 30_000 });
      const message = (await alert.first().innerText()).trim();
      const shot = await run.shot(ownerPage, 'tool-test-wrong-token');
      if (message === '') run.finding('ERROR', '/workspaces/:id Tools', 'Test with a wrong token showed an empty alert', shot);
      else run.pass(`A wrong token shows a visible message: "${message.slice(0, 140)}" (${shotOpen}, ${shot}).`);
      await ownerPage.getByRole('button', { name: 'Cancel' }).click();
    });

    let meetingLink = '';
    await step(run, ownerPage, 'create start-now meeting', async () => {
      meetingLink = await createMeeting(ownerPage, `Clickthrough start now ${suffix}`);
      const shot = await run.shot(ownerPage, 'meeting-created');
      run.pass(`Start now creates a meeting and shows its invite link (${shot}).`);
    });

    let roomOpened = false;
    await step(run, ownerPage, 'owner room and start', async () => {
      await enterOwnRoom(ownerPage, meetingLink);
      const overlay = ownerPage.getByRole('region', { name: 'Waiting for the meeting to start' });
      roomOpened = !(await overlay.isVisible().catch(() => false));
      const shot = await run.shot(ownerPage, 'owner-room-started');
      if (!roomOpened) {
        const body = (await ownerPage.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 220);
        run.finding('ERROR', '/m/:id/room after Start now', `the meeting did not start: "${body}"`, shot);
      } else {
        run.pass(`Owner enters the room and starts the meeting (${shot}).`);
      }
    });

    let invite = '';
    await step(run, ownerPage, 'invite link', async () => {
      try {
        invite = await inviteLink(ownerPage);
      } catch {
        const id = meetingLink.split('/m/')[1] ?? '';
        const code = await ownerPage.evaluate(async (meetingId) => {
          const response = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/meeting-code`);
          const body = (await response.json().catch(() => ({}))) as { code?: unknown };
          return typeof body.code === 'string' ? body.code : '';
        }, id);
        if (code !== '') {
          invite = `${BASE}/m/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`;
          run.finding(
            'LAYOUT',
            '/m/:id/room before start',
            'the waiting overlay covers the toolbar, so a guest must be invited from a different screen or by reading the code; the Invite button is present but cannot be clicked',
            await run.shot(ownerPage, 'invite-blocked-by-overlay'),
          );
        }
      }
      if (invite === '') return;
      const dialog = ownerPage.getByRole('dialog', { name: 'Invite people' });
      const qr = await dialog.locator('.kd-real-qr').count();
      const shot = await run.shot(ownerPage, 'invite-dialog');
      if (qr === 0) run.finding('LAYOUT', '/m/:id/room Invite', 'Invite popover shows no QR code', shot);
      else run.pass(`Invite popover shows the invite link and a QR code (${shot}).`);
      const open = ownerPage.getByRole('dialog', { name: 'Invite people' });
      if (await open.isVisible().catch(() => false)) {
        await ownerPage.getByRole('button', { name: 'Invite', exact: true }).click();
      }
    });
    if (invite === '') run.finding('DEAD-END', '/m/:id/room', 'no invite link could be produced, so the guest could not join');

    const guest = await guestPerson(browser, run, {
      expected: (status, url) => status === 404 && url.includes('/api/meeting-code'),
    });
    const guestPage = guest.page;

    await step(run, guestPage, 'guest join page', async () => {
      await guestPage.goto(invite);
      await guestPage.getByText('You are invited').waitFor({ timeout: 15_000 });
      const notice = guestPage.getByText('Kaki transcribes this meeting');
      await notice.waitFor({ timeout: 10_000 });
      const shot = await run.shot(guestPage, 'guest-join-page');
      run.pass(`Guest sees the meeting title, host and recording notice before joining (${shot}).`);
    });

    await step(run, guestPage, 'guest joins room', async () => {
      const nameBox = guestPage.getByLabel('Your name');
      if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(guestName);
      await guestPage.getByRole('button', { name: 'Join meeting' }).click();
      await guestPage.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 });
      await guestPage.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      const shot = await run.shot(guestPage, 'guest-in-room');
      const endButton = guestPage.getByRole('button', { name: 'End for everyone' });
      if (await endButton.isVisible().catch(() => false)) {
        run.finding('ERROR', '/m/:id/room guest', 'A guest sees the owner-only End for everyone button', shot);
      } else {
        run.pass(`Guest enters the room and sees no owner-only End button (${shot}).`);
      }
    });

    const ownerLine = `Owner line ${suffix}: we ship on Friday.`;
    const guestLine = `Guest line ${suffix}: the supplier is confirmed.`;
    const closingLine = `Owner closing line ${suffix}: minutes must keep this.`;

    await step(run, ownerPage, 'owner types', async () => {
      if (!roomOpened) return;
      await speakLine(ownerPage, ownerLine);
      await ownerPage.getByText(ownerLine).first().waitFor({ timeout: 15_000 });
      const shot = await run.shot(ownerPage, 'owner-spoken');
      run.pass(`Owner can type into the meeting and sees the line (${shot}).`);
    });

    await step(run, guestPage, 'guest types', async () => {
      if (!roomOpened) return;
      await speakLine(guestPage, guestLine);
      await guestPage.getByText(guestLine).first().waitFor({ timeout: 15_000 });
      const shot = await run.shot(guestPage, 'guest-spoken');
      run.pass(`Guest can type into the meeting and sees the line (${shot}).`);
    });

    await step(run, ownerPage, 'names in transcript', async () => {
      if (!roomOpened) return;
      await ownerPage.getByText(/Live transcript/).click();
      await ownerPage.getByText(guestLine).first().waitFor({ timeout: 20_000 });
      const body = await ownerPage.locator('.kd-dock').innerText();
      const ownerShown = body.includes(ownerName);
      const guestShown = body.includes(guestName);
      const shot = await run.shot(ownerPage, 'transcript-names');
      if (!ownerShown || !guestShown) {
        run.finding('ERROR', '/m/:id/room transcript', `Transcript names missing: owner=${ownerShown} guest=${guestShown}`, shot);
      } else {
        run.pass(`Transcript shows both people by their own names (${shot}).`);
      }
    });

    await step(run, ownerPage, 'off the record', async () => {
      if (!roomOpened) return;
      await ownerPage.getByRole('button', { name: 'Off the record', exact: true }).click();
      await ownerPage.getByText(/Off the record: nothing is being written down/).waitFor({ timeout: 10_000 });
      const shotOn = await run.shot(ownerPage, 'off-the-record-on');
      await ownerPage.getByRole('button', { name: 'Back on the record', exact: true }).click();
      await ownerPage.getByText(/Off the record: nothing is being written down/).waitFor({ state: 'hidden', timeout: 10_000 });
      const shotOff = await run.shot(ownerPage, 'off-the-record-off');
      run.pass(`Off the record shows a clear banner and turns back off (${shotOn}, ${shotOff}).`);
    });

    await step(run, guestPage, 'guest leaves and rejoins', async () => {
      await guestPage.getByRole('button', { name: 'Leave', exact: true }).click();
      await guestPage.getByText('You left the meeting').waitFor({ timeout: 20_000 });
      const shotLeft = await run.shot(guestPage, 'guest-left');
      await guestPage.getByRole('button', { name: 'Rejoin', exact: true }).click();
      await guestPage.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      const shotBack = await run.shot(guestPage, 'guest-rejoined');
      run.pass(`Guest leaves with a clear "You left" screen and rejoins (${shotLeft}, ${shotBack}).`);
    });

    await step(run, ownerPage, 'closing line and end', async () => {
      if (!roomOpened) return;
      await speakLine(ownerPage, closingLine);
      await ownerPage.getByText(closingLine).first().waitFor({ timeout: 15_000 });
      await ownerPage.getByRole('button', { name: 'End for everyone' }).click();
      await ownerPage.getByText('End for everyone?').waitFor({ timeout: 10_000 });
      const shotConfirm = await run.shot(ownerPage, 'end-confirm');
      await ownerPage.getByRole('button', { name: 'End the meeting' }).click();
      await ownerPage.getByText(/Meeting Minutes|meeting minutes|Meeting ended|ended/i).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      const shot = await run.shot(ownerPage, 'owner-after-end');
      run.pass(`Owner ends for everyone with a confirmation step (${shotConfirm}, ${shot}).`);
    });

    await step(run, ownerPage, 'workspace history after end', async () => {
      if (!roomOpened) return;
      await ownerPage.goto(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}`);
      const title = `Clickthrough start now ${suffix}`;
      await ownerPage.getByText(title).first().waitFor({ timeout: 30_000 });
      const shot = await run.shot(ownerPage, 'workspace-after-end');
      run.pass(`The ended meeting appears under Past meetings on the workspace page (${shot}).`);
      await ownerPage.getByRole('link', { name: 'Open', exact: true }).first().click();
      await ownerPage.getByRole('heading', { name: title }).waitFor({ timeout: 20_000 });
      await ownerPage.waitForTimeout(5_000);
      const shotMinutes = await run.shot(ownerPage, 'meeting-history-minutes');
      const body = await ownerPage.locator('main').innerText();
      const stillPreparing = /still being prepared/i.test(body);
      const closingKept = body.includes(closingLine);
      if (closingKept) {
        run.pass(`The line spoken just before End reaches the minutes (${shotMinutes}).`);
      } else {
        run.finding(
          'ERROR',
          '/workspaces/:id/meetings/:meetingId minutes',
          stillPreparing
            ? 'minutes still "being prepared" 5 s after End, so the closing line is not yet in the record'
            : 'the line spoken just before End is missing from the minutes',
          shotMinutes,
        );
      }
    });

    await step(run, guestPage, 'guest after end', async () => {
      await guestPage.waitForTimeout(3_000);
      const shot = await run.shot(guestPage, 'guest-after-end');
      const body = await guestPage.locator('body').innerText();
      if (/You left the meeting|Meeting ended|meeting has ended|Rejoin/i.test(body)) {
        run.pass(`Guest gets a visible answer after the owner ends the meeting (${shot}).`);
      } else {
        run.finding('CONFUSING', '/m/:id/room after End', 'guest screen has no visible "meeting ended" answer', shot);
      }
    });

    // Phone pass: the same journey up to the room.
    const phone = await signedInPerson(browser, run, {
      name: ownerName,
      email: `owner1-${suffix}@clickthrough.test`,
      viewport: { width: 390, height: 844 },
    });
    const phonePage = phone.page;
    await step(run, phonePage, 'phone new meeting', async () => {
      await phonePage.goto(BASE + '/new');
      await phonePage.locator('#new-meeting-title').waitFor({ timeout: 20_000 });
      const shot = await run.shot(phonePage, 'phone-new-meeting');
      const overflow = await phonePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (overflow) run.finding('LAYOUT', '/new at 390x844', 'page scrolls sideways on a phone', shot);
      else run.pass(`New meeting fits a 390x844 phone (${shot}).`);
      const link = await createMeeting(phonePage, `Phone meeting ${suffix}`);
      await enterOwnRoom(phonePage, link);
      const roomShot = await run.shot(phonePage, 'phone-room');
      const roomOverflow = await phonePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      if (roomOverflow) run.finding('LAYOUT', '/m/:id/room at 390x844', 'room scrolls sideways on a phone', roomShot);
      else run.pass(`The meeting room fits a 390x844 phone (${roomShot}).`);
      await inviteLink(phonePage);
      const inviteShot = await run.shot(phonePage, 'phone-invite-dialog');
      run.pass(`The invite popover opens on a phone (${inviteShot}).`);
    });
    await phone.context.close();
  } finally {
    run.save();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
