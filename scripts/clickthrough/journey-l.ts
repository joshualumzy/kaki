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
  speakLine,
  signedInPerson,
  stamp,
  withJourneyLock,
  closeBrowser,
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

/** Wait until the room has either its normal controls or a rejoin/left answer, and say which one it is. */
async function roomAnswer(
  page: Page,
  kind: 'real' | 'practice',
  timeout = RECOVER_MS,
): Promise<'room' | 'rejoin' | 'left' | 'other'> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const body = await text(page);
    if (/You left the meeting/.test(body)) return 'left';
    if (/Reconnecting to your meeting|Could not get back into the meeting|Rejoin needed/.test(body)) return 'rejoin';
    // Both modes have Leave: speaking is the only input, so there is no text box to look for.
    void kind;
    const controls = page.getByRole('button', { name: 'Leave', exact: true });
    if (await controls.isVisible().catch(() => false)) return 'room';
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
  kind: 'real' | 'practice',
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
  const answer = await roomAnswer(page, kind);
  const after = await text(page);
  const afterShot = await run.shot(page, `${where}-after-online`);
  run.note(`${where} after ${OFFLINE_MS / 1000} s offline: ${answer}; screen said "${after.slice(0, 260)}" (${afterShot}).`);
  if (answer === 'room') run.pass(`${where}: the room came back by itself after the network returned (${afterShot}).`);
  else if (answer === 'rejoin') {
    run.finding('DEAD-END', where, `the room did not come back by itself; the person is left on a rejoin screen: "${after.slice(0, 220)}"`, afterShot);
  } else {
    run.finding('ERROR', where, `after the network returned the page showed neither the room nor a rejoin answer: "${after.slice(0, 220)}"`, afterShot);
  }
  return answer;
}

/** A microphone-denied attempt must explain exactly how to allow it, with no typing fallback. */
async function expectMicHelp(run: Run, page: Page, where: string): Promise<void> {
  const alert = page.getByRole('alert').first();
  const shown = await alert.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  const shot = await run.shot(page, where.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  const message = shown ? (await alert.innerText()).replace(/\s+/g, ' ').trim() : '';
  if (!shown) {
    run.finding('ERROR', where, 'a denied microphone showed no message at all', shot);
    return;
  }
  // A real meeting asks for the microphone "to take part"; a speech-only practice asks "to speak
  // in the meeting". Both must name the browser's site settings, which is the way out.
  if (!/Allow it in your browser's site settings to (?:take part|speak in the meeting)\./.test(message)) {
    run.finding('CONFUSING', where, `the message does not say how to allow the microphone: "${message}"`, shot);
  } else {
    run.pass(`${where}: a denied microphone gets the plain site-settings message: "${message}" (${shot}).`);
  }
  if (await page.getByRole('button', { name: /Type$/ }).isVisible().catch(() => false)) {
    run.finding('CONFUSING', where, 'typing is still offered with the microphone denied', shot);
  }
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
      expected: (status, url) => status === 403 && url.includes('/meeting-code'),
    });
    let invite = '';
    let meetingId = '';
    await step(run, owner.page, 'real meeting setup', async () => {
      const link = await createMeeting(owner.page, `Network drop ${suffix}`);
      meetingId = /\/m\/([^/?#]+)/.exec(link)?.[1] ?? '';
      await enterOwnRoom(owner.page, link);
      invite = await inviteLink(owner.page);
      // Close the invite popover again so it cannot sit over the controls used later.
      await owner.page.getByRole('button', { name: 'Invite', exact: true }).click();
      run.pass(`A real meeting is open with an invite link (${await run.shot(owner.page, 'real-owner-room')}).`);
    });

    const guest = await guestPerson(browser, run, {
      expected: (status, url) => status === 403 && url.includes('/meeting-code'),
    });
    const guestName = `Drop Guest ${suffix}`;
    await step(run, guest.page, 'guest joins real meeting', async () => {
      await joinAsGuest(guest.page, invite, guestName);
      run.pass(`A guest is in the real meeting (${await run.shot(guest.page, 'real-guest-room')}).`);
    });

    if (invite !== '') {
      const answer = await networkDrop(run, guest.page, guest.context, 'real meeting guest', 'real');
      if (answer === 'room') {
        await step(run, guest.page, 'real captions recover', async () => {
          const line = `After the drop, this line still arrives ${suffix}.`;
          await speakLine(owner.page, line);
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

    // ---- Microphone denied in a real room: the person joins with the mic off, then tries it. ----
    const noMicReal = await guestPerson(browser, run, {
      expected: (status, url) => status === 403 && url.includes('/meeting-code'),
    });
    if (invite !== '') {
      await step(run, noMicReal.page, 'real meeting mic denied', async () => {
        await joinAsGuest(noMicReal.page, invite, `No Mic ${suffix}`);
        const mic = noMicReal.page.getByRole('button', { name: 'Mic off', exact: true });
        await mic.click();
        await expectMicHelp(run, noMicReal.page, 'real meeting microphone denied');
        // Speaking still reaches the meeting through the fake recogniser with the browser mic denied.
        const line = `Speaking works with the mic denied ${suffix}.`;
        await speakLine(noMicReal.page, line);
        const seen = await noMicReal.page.getByText(line).first().waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
        if (seen) run.pass('A person with a denied mic can still take part by speaking.');
        else run.finding('DEAD-END', 'real meeting microphone denied', 'a spoken line does not reach the meeting when the browser mic is denied', await run.shot(noMicReal.page, 'real-mic-denied-speaking'));
      });
    }

    // ---- End and close the real meeting so practice can run (the server allows one at a time). ----
    await step(run, owner.page, 'close the real meeting', async () => {
      await owner.page.getByRole('button', { name: 'End for everyone' }).click();
      await owner.page.getByRole('button', { name: 'End the meeting' }).click();
      await owner.page.getByRole('region', { name: 'Meeting ended' }).waitFor({ timeout: 30_000 });
      const response = await owner.page.request.post(
        `${BASE}/api/meetings/${encodeURIComponent(meetingId)}/meeting/close`,
      );
      // A 409 here means the ended room was already released (the empty-room watch finished the
      // review first); anything else is a real failure.
      if (!response.ok() && response.status() !== 409) {
        throw new Error(`closing the meeting answered HTTP ${response.status()}`);
      }
      run.pass(
        response.status() === 409
          ? 'The real meeting ended, and the server had already released the room.'
          : 'The real meeting was ended and closed.',
      );
    });
    await noMicReal.context.close();
    await guest.context.close();
    await owner.context.close();

    // ---- The practice meeting: mic denied on the join form, then join, start, network drop. ----
    const practice = await guestPerson(browser, run);
    await step(run, practice.page, 'practice mic denied', async () => {
      await practice.page.goto(`${BASE}/practice`);
      await practice.page.getByRole('button', { name: 'Microphone', exact: true }).click();
      await expectMicHelp(run, practice.page, 'practice microphone denied');
    });
    await step(run, practice.page, 'practice join and start', async () => {
      await practice.page.locator('#join-name').fill(`Practice Drop ${suffix}`);
      await practice.page.getByRole('button', { name: /Join with mic/ }).click();
      // Wait for the briefing itself, then for the meeting to be marked started.
      const briefing = practice.page.getByRole('region', { name: 'Before the meeting starts' });
      await briefing.waitFor({ timeout: 60_000 });
      await practice.page.getByRole('button', { name: /Next: How to play/ }).click();
      await practice.page.getByRole('button', { name: 'Start the meeting' }).click();
      await briefing.waitFor({ state: 'hidden', timeout: 60_000 });
      await practice.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 30_000 });
      run.pass(`The practice meeting is running for the drop check (${await run.shot(practice.page, 'practice-running')}).`);
    });
    const practiceAnswer = await networkDrop(run, practice.page, practice.context, 'practice meeting', 'practice');
    if (practiceAnswer === 'room') {
      await step(run, practice.page, 'practice speech recovers', async () => {
        const line = `Still here after the drop ${suffix}.`;
        await speakLine(practice.page, line);
        const seen = await practice.page
          .getByText(line)
          .first()
          .waitFor({ timeout: 25_000 })
          .then(() => true)
          .catch(() => false);
        const shot = await run.shot(practice.page, 'practice-after-speech');
        if (seen) run.pass(`Practice accepts a spoken line again after the drop (${shot}).`);
        else run.finding('ERROR', 'practice meeting after drop', 'a spoken line does not come back after the network returns', shot);
      });
    } else {
      const briefingBack = await practice.page
        .getByRole('region', { name: 'Before the meeting starts' })
        .isVisible()
        .catch(() => false);
      if (briefingBack) {
        run.finding(
          'DEAD-END',
          'practice meeting after drop',
          'the briefing covers the stage again after the network returns, so the meeting was reset and what the visitor says is ignored until Start is pressed again',
          await run.shot(practice.page, 'practice-briefing-back'),
        );
      }
    }

    await practice.context.close();
  } finally {
    run.save();
    await closeBrowser(browser);
  }
}

void withJourneyLock(JOURNEY, main).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
