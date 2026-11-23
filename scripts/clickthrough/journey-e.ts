import type { Page } from 'playwright';
import {
  BASE,
  createMeeting,
  enterOwnRoom,
  guestPerson,
  inviteLink,
  joinAsGuest,
  launch,
  Run,
  signedInPerson,
  stamp,
  waitForRoomBar,
  workspaces,
  withJourneyLock,
  closeBrowser,
} from './lib';

const JOURNEY = 'e';

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
  const ownerName = `Owner Four ${suffix}`;
  const guestName = `Guest Four ${suffix}`;
  const title = `Wrong turns ${suffix}`;
  let workspaceId = '';
  let meetingId = '';

  try {
    const owner = await signedInPerson(browser, run, { name: ownerName, email: `owner4-${suffix}@clickthrough.test` });
    const page = owner.page;
    const guest = await guestPerson(browser, run);
    const anon = await guestPerson(browser, run);

    await step(run, page, 'setup meeting', async () => {
      await page.goto(`${BASE}/new`);
      await page.locator('#new-meeting-title').waitFor({ timeout: 20_000 });
      const list = await workspaces(page);
      workspaceId = list.find((workspace) => workspace.kind === 'personal')?.id ?? '';
      const link = await createMeeting(page, title);
      meetingId = decodeURIComponent(new URL(link).pathname.replace('/m/', ''));
      await enterOwnRoom(page, link);
      const shot = await run.shot(page, 'owner-room');
      run.pass(`Owner meeting is open for the wrong-turn checks (${shot}).`);
      const invite = await inviteLink(page);
      await page.getByRole('button', { name: 'Invite', exact: true }).click();
      await joinAsGuest(guest.page, invite, guestName);
      const guestShot = await run.shot(guest.page, 'guest-room');
      run.pass(`Guest is in the same room (${guestShot}).`);
    });

    await step(run, page, 'owner refresh', async () => {
      await page.reload();
      await waitForRoomBar(page);
      const shot = await run.shot(page, 'owner-after-refresh');
      const body = await page.locator('body').innerText();
      if (body.includes(ownerName) && /Leave/.test(body)) {
        run.pass(`Refreshing the owner's room brings them back with their own name (${shot}).`);
      } else {
        run.finding('ERROR', '/m/:id/room after refresh', 'owner does not get back into the same room', shot);
      }
    });

    await step(run, guest.page, 'guest refresh', async () => {
      await guest.page.reload();
      await waitForRoomBar(guest.page);
      const shot = await run.shot(guest.page, 'guest-after-refresh');
      const body = await guest.page.locator('body').innerText();
      if (body.includes(guestName)) run.pass(`Refreshing the guest's room brings them back under their own name (${shot}).`);
      else run.finding('CONFUSING', '/m/:id/room after guest refresh', 'guest is back but their name is not shown', shot);
    });

    await step(run, guest.page, 'back from room', async () => {
      await guest.page.goBack();
      await guest.page.waitForTimeout(1_500);
      const shot = await run.shot(guest.page, 'guest-back-from-room');
      const body = await guest.page.locator('body').innerText();
      if (body.trim() === '') run.finding('DEAD-END', 'browser back from /m/:id/room', 'blank page after Back', shot);
      else run.pass(`Back from the guest's room lands on a real page at ${guest.page.url().replace(BASE, '')} (${shot}).`);
    });

    await step(run, page, 'back from workspace', async () => {
      await page.goto(`${BASE}/workspaces/${encodeURIComponent(workspaceId)}`);
      await page.getByRole('heading', { name: 'My workspace' }).waitFor({ timeout: 20_000 });
      await page.goBack();
      await page.waitForTimeout(1_500);
      const shot = await run.shot(page, 'owner-back-from-workspace');
      const body = await page.locator('body').innerText();
      if (body.trim() === '') run.finding('DEAD-END', 'browser back from a workspace page', 'blank page after Back', shot);
      else run.pass(`Back from the workspace page lands on a real page at ${page.url().replace(BASE, '')} (${shot}).`);
    });

    await step(run, anon.page, 'unknown meeting link', async () => {
      await anon.page.goto(`${BASE}/m/does-not-exist`);
      await anon.page.getByText("This meeting link isn't valid").waitFor({ timeout: 20_000 });
      const shot = await run.shot(anon.page, 'unknown-meeting-link');
      const forward = await anon.page.getByRole('link', { name: 'Go to Kaki' }).isVisible();
      if (!forward) run.finding('DEAD-END', '/m/does-not-exist', 'friendly card has no way forward', shot);
      else run.pass(`An unknown meeting link shows a friendly card with a way forward (${shot}).`);
    });

    await step(run, anon.page, 'unknown meeting room', async () => {
      await anon.page.goto(`${BASE}/m/does-not-exist/room`);
      await anon.page.waitForTimeout(6_000);
      const shot = await run.shot(anon.page, 'unknown-meeting-room');
      const body = (await anon.page.locator('body').innerText()).trim();
      const blank = body === '';
      const spinner = /Loading|Checking|Connecting/i.test(body) && body.length < 200;
      if (blank) run.finding('DEAD-END', '/m/does-not-exist/room', 'blank page', shot);
      else if (spinner) run.finding('DEAD-END', '/m/does-not-exist/room', `endless spinner/loading text: "${body.replace(/\s+/g, ' ').slice(0, 120)}"`, shot);
      else run.pass(`An unknown meeting room shows an answer: "${body.replace(/\s+/g, ' ').slice(0, 140)}" (${shot}).`);
    });

    await step(run, page, 'end meeting', async () => {
      await page.goto(`${BASE}/m/${encodeURIComponent(meetingId)}/room`);
      await waitForRoomBar(page);
      // The room's control socket may still be reconnecting after the join swapped the session,
      // so a single End can be dropped. Press it again until the meeting really is over.
      const asEnded = async (): Promise<string> =>
        page.evaluate(async (id) => {
          const response = await fetch(`/api/meetings/${encodeURIComponent(id)}/info`);
          const body = (await response.json().catch(() => ({}))) as { status?: unknown };
          return typeof body.status === 'string' ? body.status : '';
        }, meetingId);
      let ended = false;
      for (let attempt = 0; attempt < 6 && !ended; attempt += 1) {
        if ((await asEnded()) === 'ended') {
          ended = true;
          break;
        }
        const start = page.getByRole('button', { name: 'End for everyone' });
        if (await start.isVisible().catch(() => false)) {
          await start.click();
          const confirm = page.getByRole('button', { name: 'End the meeting' });
          if (await confirm.isVisible().catch(() => false)) await confirm.click();
        }
        await page.waitForTimeout(2_000);
        ended = (await asEnded()) === 'ended';
      }
      const shot = await run.shot(page, 'meeting-ended');
      if (!ended) {
        run.finding('ERROR', '/m/:id/room End for everyone', 'the meeting did not end after six presses', shot);
        return;
      }
      run.pass(`The meeting was ended for the later link checks (${shot}).`);
    });

    await step(run, anon.page, 'ended meeting link', async () => {
      await anon.page.goto(`${BASE}/m/${encodeURIComponent(meetingId)}`);
      await anon.page.waitForTimeout(4_000);
      const shot = await run.shot(anon.page, 'ended-meeting-join-page');
      const body = (await anon.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      const friendly = /ended|no longer|isn't valid|not available|finished/i.test(body);
      if (body === '') run.finding('DEAD-END', '/m/:id for an ended meeting', 'blank page', shot);
      else if (!friendly) {
        run.finding(
          'CONFUSING',
          '/m/:id for an ended meeting',
          `join page looks like a normal invite for an ended meeting with no ended notice; it says "${body.slice(0, 140)}"`,
          shot,
        );
      } else run.pass(`An ended meeting's link says it is no longer available (${shot}).`);
    });

    await step(run, anon.page, 'ended meeting room', async () => {
      await anon.page.goto(`${BASE}/m/${encodeURIComponent(meetingId)}/room`);
      await anon.page.waitForTimeout(8_000);
      const shot = await run.shot(anon.page, 'ended-meeting-room');
      const body = (await anon.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
      if (body === '') run.finding('DEAD-END', '/m/:id/room for an ended meeting', 'blank page', shot);
      else if (/ended|no longer|isn't valid|not available|could not|can't join|cannot join/i.test(body)) {
        run.pass(`An ended meeting's room shows a clear answer: "${body.slice(0, 140)}" (${shot}).`);
      } else {
        run.finding('CONFUSING', '/m/:id/room for an ended meeting', `no clear ended message; page says "${body.slice(0, 140)}"`, shot);
      }
    });

    await step(run, anon.page, 'guest workspace pages', async () => {
      const shots: string[] = [];
      for (const [label, path] of [
        ['workspace', `/workspaces/${encodeURIComponent(workspaceId)}`],
        ['new', '/new'],
        ['history', `/workspaces/${encodeURIComponent(workspaceId)}/meetings/${encodeURIComponent(meetingId)}`],
      ] as Array<[string, string]>) {
        await anon.page.goto(BASE + path);
        await anon.page.waitForTimeout(2_500);
        const shot = await run.shot(anon.page, `guest-${label}`);
        shots.push(shot);
        const body = (await anon.page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
        const url = anon.page.url().replace(BASE, '');
        if (body === '') {
          run.finding('DEAD-END', path + ' as a guest', 'blank page', shot);
        } else if (url.startsWith('/signin')) {
          if (/Sign in to open the page/i.test(body)) {
            run.pass(`A guest opening ${path} is sent to sign-in with a line saying why (${shot}).`);
          } else {
            run.finding(
              'CONFUSING',
              path + ' as a guest',
              `redirected to ${url} with no message saying why sign-in is needed; page shows "${body.slice(0, 100)}"`,
              shot,
            );
          }
        } else if (/not found|isn't valid|does not exist/i.test(body)) {
          run.pass(`A guest opening ${path} gets a clear not-found message (${shot}).`);
        } else {
          run.pass(`A guest opening ${path} sees a real page (${shot}).`);
        }
      }
      run.note(`Guest redirect screenshots: ${shots.join(', ')}.`);
    });

    await step(run, page, 'other signed-in workspace', async () => {
      const other = await signedInPerson(browser, run, {
        name: `Other Owner ${suffix}`,
        email: `other-${suffix}@clickthrough.test`,
      });
      await other.page.goto(`${BASE}/new`);
      await other.page.locator('#new-meeting-title').waitFor({ timeout: 20_000 });
      const otherList = await workspaces(other.page);
      const otherWorkspace = otherList.find((workspace) => workspace.kind === 'personal');
      await other.context.close();
      if (otherWorkspace === undefined) throw new Error('other user has no personal workspace');
      await page.goto(`${BASE}/workspaces/${encodeURIComponent(otherWorkspace.id)}`);
      await page.getByText('Workspace not found').waitFor({ timeout: 20_000 });
      const shot = await run.shot(page, 'other-workspace-not-found');
      run.pass(`A signed-in user opening someone else's workspace gets a clear "Workspace not found" card (${shot}).`);
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
