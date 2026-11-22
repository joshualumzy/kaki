import type { Browser, Page } from 'playwright';
import {
  BASE,
  createMeeting,
  enterOwnRoom,
  guestPerson,
  inviteLink,
  joinAsGuest,
  launch,
  Run,
  sendTyped,
  signedInPerson,
  stamp,
} from './lib';

const JOURNEY = 'l';
/** How long the network stays down in each drop check. */
const OFFLINE_MS = 20_000;
/** How long the room is given to come back by itself after the network returns. */
const RECOVER_MS = 60_000;

async function step(run: Run, page: Page, where: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const shot = await run.shot(page, `failed-${where.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => '');
    run.finding('ERROR', where, `step threw: ${error instanceof Error ? error.message : String(error)}`, shot);
  }
}

function text(page: Page): Promise<string> {
  return page.locator('body').innerText().catch(() => '').then((body) => body.replace(/\s+/g, ' ').trim());
}

/** Wait until the room has either its normal bar or a rejoin/left answer, and say which one it is. */
async function roomAnswer(page: Page, timeout = RECOVER_MS): Promise<'room' | 'rejoin' | 'left' | 'other'> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const body = await text(page);
    if (/You left the meeting/.test(body)) return 'left';
    if (/Reconnecting to your meeting|Could not get back into the meeting|Rejoin needed/.test(body)) return 'rejoin';
    if (await page.getByRole('button', { name: 'Leave', exact: true }).isVisible().catch(() => false)) return 'room';
    await page.waitForTimeout(1_000);
  }
  return 'other';
}

/** Drop this browser context's network for a while and record what the screen said at each stage. */
async function networkDrop(
  run: Run,
  page: Page,
  context: { setOffline(offline: boolean): Promise<void> },
  where: string,
): Promise<'room' | 'rejoin' | 'left' | 'other'> {
  const during: string[] = [];
  await context.setOffline(true);
  await page.waitForTimeout(1_500);
  during.push(`after 1.5 s: "${(await text(page)).slice(0, 220)}"`);
  await run.shot(page, `${where}-offline-early`);
  const until = Date.now() + OFFLINE_MS - 1_500;
  while (Date.now() < until) {
    await page.waitForTimeout(3_000);
    during.push(`after ${Math.round((OFFLINE_MS - (until - Date.now())) / 1000)} s: "${(await text(page)).slice(0, 220)}"`);
  }
  const duringShot = await run.shot(page, `${where}-offline-late`);
  const sawMessage = during.some((line) =>
    /offline|connection|reconnect|internet|network|can't hear|couldn't connect|lost/i.test(line),
  );
  if (sawMessage) run.pass(`${where}: the page said something about the connection while offline (${duringShot}).`);
  else run.finding('CONFUSING', where, `nothing on screen explained the dropped network: ${during.join(' | ')}`, duringShot);

  await context.setOffline(false);
  const answer = await roomAnswer(page);
  const after = await text(page);
  const afterShot = await run.shot(page, `${where}-after-online`);
  run.note(`${where} after 20 s offline: ${answer}; screen said "${after.slice(0, 260)}" (${afterShot}).`);
  if (answer === 'room') run.pass(`${where}: the room came back by itself after the network returned (${afterShot}).`);
  else if (answer === 'rejoin') {
    run.finding('DEAD-END', where, `the room did not come back by itself; the person is left on a rejoin screen: "${after.slice(0, 220)}"`, afterShot);
  } else {
    run.finding('ERROR', where, `after the network returned the page showed neither the room nor a rejoin answer: "${after.slice(0, 220)}"`, afterShot);
  }
  return answer;
}

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser: Browser = await launch();
  const suffix = stamp();
  try {
    // ---- A real meeting: owner starts it, a guest joins, the guest's network drops. ----
    const owner = await signedInPerson(browser, run, {
      name: `Drop Owner ${suffix}`,
      email: `drop-owner-${suffix}@clickthrough.test`,
    });
    let invite = '';
    await step(run, owner.page, 'real meeting setup', async () => {
      const link = await createMeeting(owner.page, `Network drop ${suffix}`);
      await enterOwnRoom(owner.page, link);
      invite = await inviteLink(owner.page);
      await owner.page.getByRole('button', { name: 'Invite', exact: true }).click();
      run.pass(`A real meeting is open with an invite link (${await run.shot(owner.page, 'real-owner-room')}).`);
    });

    const guest = await guestPerson(browser, run, {
      expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
    });
    const guestName = `Drop Guest ${suffix}`;
    await step(run, guest.page, 'guest joins real meeting', async () => {
      await joinAsGuest(guest.page, invite, guestName);
      run.pass(`A guest is in the real meeting (${await run.shot(guest.page, 'real-guest-room')}).`);
    });

    if (invite !== '') {
      const answer = await networkDrop(run, guest.page, guest.context, 'real meeting guest');
      if (answer === 'room') {
        await step(run, guest.page, 'real captions recover', async () => {
          const line = `After the drop, this line still arrives ${suffix}.`;
          await sendTyped(owner.page, line);
          const seen = await guest.page
            .getByText(line)
            .first()
            .waitFor({ timeout: 25_000 })
            .then(() => true)
            .catch(() => false);
          const shot = await run.shot(guest.page, 'real-after-caption');
          if (seen) run.pass(`Captions reach the guest again after the drop (${shot}).`);
          else run.finding('ERROR', 'real meeting after drop', 'the guest does not see new captions after the network returns', shot);
          const body = await text(guest.page);
          if (body.includes(guestName)) run.pass(`The guest still holds their own seat after the drop (${shot}).`);
          else run.finding('ERROR', 'real meeting after drop', 'the guest is back but their name is not shown', shot);
        });
      }
    }

    // ---- The practice meeting: join, start, network drops, then come back. ----
    const practice = await guestPerson(browser, run, {
      expected: (status, url) => status === 401 && url.includes('/api/auth/me'),
    });
    await step(run, practice.page, 'practice join and start', async () => {
      await practice.page.goto(`${BASE}/practice`);
      await practice.page.locator('#join-name').fill(`Practice Drop ${suffix}`);
      await practice.page.getByRole('button', { name: /Join to type|Join with mic/ }).click();
      // Wait for the briefing itself, not the type bar (which is in the page even before Start).
      const briefing = practice.page.getByRole('region', { name: 'Before the meeting starts' });
      await briefing.waitFor({ timeout: 60_000 });
      await practice.page.getByRole('button', { name: /Next: How to play/ }).click();
      await practice.page.getByRole('button', { name: 'Start the meeting' }).click();
      await briefing.waitFor({ state: 'hidden', timeout: 60_000 });
      await practice.page.getByLabel('Type to the meeting').waitFor({ timeout: 30_000 });
      run.pass(`The practice meeting is running for the drop check (${await run.shot(practice.page, 'practice-running')}).`);
    });
    const practiceAnswer = await networkDrop(run, practice.page, practice.context, 'practice meeting');
    if (practiceAnswer === 'room') {
      await step(run, practice.page, 'practice typing recovers', async () => {
        const briefingBack = await practice.page
          .getByRole('region', { name: 'Before the meeting starts' })
          .isVisible()
          .catch(() => false);
        if (briefingBack) {
          run.finding(
            'DEAD-END',
            'practice meeting after drop',
            'the briefing covers the stage again after the network returns, so the meeting was reset and typed lines are ignored until Start is pressed again',
            await run.shot(practice.page, 'practice-briefing-back'),
          );
          return;
        }
        const line = `Still here after the drop ${suffix}.`;
        const box = practice.page.getByLabel('Type to the meeting');
        await box.fill(line);
        await box.press('Enter');
        const seen = await practice.page
          .getByText(line)
          .first()
          .waitFor({ timeout: 25_000 })
          .then(() => true)
          .catch(() => false);
        const shot = await run.shot(practice.page, 'practice-after-type');
        if (seen) run.pass(`Practice accepts a typed line again after the drop (${shot}).`);
        else run.finding('ERROR', 'practice meeting after drop', 'a typed line does not come back after the network returns', shot);
      });
    }

    // ---- Microphone denied: real meeting. The guest joins by typing, then tries the mic. ----
    const noMicReal = await guestPerson(browser, run, {
      expected: (status, url) =>
        (status === 401 && url.includes('/api/auth/me')) ||
        (status === 403 && /permission|microphone/i.test(url)),
    });
    await step(run, noMicReal.page, 'real meeting mic denied', async () => {
      await joinAsGuest(noMicReal.page, invite, `No Mic ${suffix}`);
      const mic = noMicReal.page.getByRole('button', { name: 'Mic off', exact: true });
      await mic.click();
      const alert = noMicReal.page.getByRole('alert').first();
      const shown = await alert.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
      const shot = await run.shot(noMicReal.page, 'real-mic-denied');
      const message = shown ? (await alert.innerText()).replace(/\s+/g, ' ').trim() : '';
      if (!shown) {
        run.finding('ERROR', 'real meeting microphone denied', 'turning the mic on with permission denied showed no message', shot);
      } else if (!/allow|setting|lock|type/i.test(message)) {
        run.finding('CONFUSING', 'real meeting microphone denied', `the message does not say what to do: "${message}"`, shot);
      } else {
        run.pass(`The real room explains a denied mic: "${message}" (${shot}).`);
      }
      // Typing must still work with the microphone denied.
      const line = `Typing works with the mic denied ${suffix}.`;
      await sendTyped(noMicReal.page, line);
      const typed = await noMicReal.page.getByText(line).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
      if (typed) run.pass('A person with a denied mic can still type in the real meeting.');
      else run.finding('DEAD-END', 'real meeting microphone denied', 'typing does not work either when the mic is denied', await run.shot(noMicReal.page, 'real-mic-denied-typing'));
    });

    // ---- Microphone denied: practice join form. ----
    const noMicPractice = await guestPerson(browser, run, {
      expected: (status, url) =>
        (status === 401 && url.includes('/api/auth/me')) ||
        (status === 403 && /permission|microphone/i.test(url)),
    });
    await step(run, noMicPractice.page, 'practice mic denied', async () => {
      await noMicPractice.page.goto(`${BASE}/practice`);
      await noMicPractice.page.getByRole('button', { name: 'Microphone', exact: true }).click();
      const alert = noMicPractice.page.getByRole('alert').first();
      const shown = await alert.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
      const shot = await run.shot(noMicPractice.page, 'practice-mic-denied');
      const message = shown ? (await alert.innerText()).replace(/\s+/g, ' ').trim() : '';
      if (!shown) {
        run.finding('ERROR', 'practice microphone denied', 'turning the mic on with permission denied showed no message', shot);
      } else if (!/allow|setting|lock|type/i.test(message)) {
        run.finding('CONFUSING', 'practice microphone denied', `the message does not say what to do: "${message}"`, shot);
      } else {
        run.pass(`The practice join form explains a denied mic: "${message}" (${shot}).`);
      }
      // The form must still let the person join to type.
      const join = noMicPractice.page.getByRole('button', { name: 'Join to type' });
      const canType = await join.isVisible().catch(() => false);
      if (canType) run.pass('The practice join form still offers Join to type with the mic denied.');
      else run.finding('DEAD-END', 'practice microphone denied', 'with the mic denied there is no way to join and type', shot);
    });

    await guest.context.close();
    await practice.context.close();
    await noMicReal.context.close();
    await noMicPractice.context.close();
  } finally {
    run.save();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
