import type { Page } from 'playwright';
import {
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
} from './lib';

const JOURNEY = 'f';
const SAMPLE_ID = 'sample-nanyang-kopi';

async function step(run: Run, page: Page, where: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const shot = await run.shot(page, `failed-${where.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => '');
    run.finding('ERROR', where, `step threw: ${error instanceof Error ? error.message : String(error)}`, shot);
  }
}

async function ask(page: Page, question: string): Promise<void> {
  const panel = page.getByLabel('Wingman');
  const box = panel.getByLabel('Ask Kaki about this meeting');
  await box.fill(question);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  await panel.getByText(`You asked: ${question}`).waitFor({ timeout: 90_000 }).catch(async (error) => {
    const text = (await panel.innerText().catch(() => '')).replace(/\s+/g, ' ');
    throw new Error(`${error instanceof Error ? error.message : String(error)}; panel said: ${text.slice(0, 400)}`);
  });
}

async function noteText(page: Page): Promise<string> {
  return (await page.getByLabel('Wingman').locator('.kd-wingman-note').last().innerText()).replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
  const run = new Run(JOURNEY);
  const browser = await launch();
  const suffix = stamp();
  const ownerName = `Wingman Owner ${suffix}`;
  const guestName = `Wingman Guest ${suffix}`;

  try {
    const owner = await signedInPerson(browser, run, {
      name: ownerName,
      email: `owner6-${suffix}@clickthrough.test`,
    });
    const page = owner.page;

    let link = '';
    await step(run, page, 'meeting in the sample workspace', async () => {
      link = await createMeeting(page, `Wingman clickthrough ${suffix}`, { workspaceId: SAMPLE_ID });
      await enterOwnRoom(page, link);
      await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
      const shot = await run.shot(page, 'owner-room');
      run.pass(`Owner is in a started real meeting in the sample workspace (${shot}).`);
    });
    if (link === '') return;

    await step(run, page, 'type meeting facts', async () => {
      await speakLine(page, `We agreed to move the launch to Friday (${suffix}).`);
      await speakLine(page, 'The supplier delivery window is three working days, per our supplier SOP.');
      await page.getByText(`We agreed to move the launch to Friday (${suffix}).`).first().waitFor({ state: 'attached', timeout: 20_000 });
      const shot = await run.shot(page, 'meeting-facts-spoken');
      run.pass(`Owner spoke the facts the Wingman must ground its answer in (${shot}).`);
    });

    await step(run, page, 'owner asks what they missed', async () => {
      await ask(page, 'What did I miss?');
      const text = await noteText(page);
      const sources = await page.getByLabel('Wingman').locator('.kd-wingman-sources').last().innerText().catch(() => '');
      const shot = await run.shot(page, 'owner-wingman-answer');
      if (sources.trim() === '') {
        run.finding(
          'ERROR',
          '/m/:id/room Wingman (owner)',
          `the owner's answer has no sources: "${text.slice(0, 220)}"`,
          shot,
        );
      } else {
        run.pass(`Owner's "what did I miss?" answer came with sources: "${text.slice(0, 160)}" (${shot}).`);
      }
    });

    await step(run, page, 'owner asks about workspace records', async () => {
      await ask(page, 'What do our workspace records say about the supplier delivery window?');
      const text = await noteText(page);
      const shot = await run.shot(page, 'owner-wingman-records');
      if (/couldn't read this meeting/i.test(text)) {
        run.finding('ERROR', '/m/:id/room Wingman (owner)', `the workspace question failed: "${text.slice(0, 220)}"`, shot);
      } else {
        run.pass(`Owner's workspace-record question got an answer instead of hanging on "reading": "${text.slice(0, 160)}" (${shot}).`);
      }
    });

    const invite = await inviteLink(page);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const guest = await guestPerson(browser, run);
    await step(run, guest.page, 'guest joins', async () => {
      await joinAsGuest(guest.page, invite, guestName);
      const shot = await run.shot(guest.page, 'guest-room');
      run.pass(`Guest is in the same real meeting under their own name (${shot}).`);
    });

    await step(run, guest.page, 'guest asks what they missed', async () => {
      await ask(guest.page, 'What did I miss?');
      const text = await noteText(guest.page);
      const sources = await guest.page
        .getByLabel('Wingman')
        .locator('.kd-wingman-sources')
        .last()
        .innerText()
        .catch(() => '');
      const shot = await run.shot(guest.page, 'guest-wingman-answer');
      const combined = `${text} ${sources}`;
      const leaked = /wiki|gitea|mattermost|mailpit|calendar/i.test(combined);
      const facts = await guest.page.getByLabel('Wingman').locator('.kd-wingman-facts').count();
      if (leaked || facts > 0) {
        run.finding(
          'ERROR',
          '/m/:id/room Wingman (guest)',
          `a guest was shown workspace records: facts=${facts} "${combined.slice(0, 240)}"`,
          shot,
        );
      } else {
        run.pass(`Guest's answer is meeting-only with no workspace records: "${text.slice(0, 160)}" (${shot}).`);
      }
    });

    await step(run, guest.page, 'guest asks about workspace records', async () => {
      await ask(guest.page, 'What do our workspace records say about the supplier delivery window?');
      const text = await noteText(guest.page);
      const sources = await guest.page
        .getByLabel('Wingman')
        .locator('.kd-wingman-sources')
        .last()
        .innerText()
        .catch(() => '');
      const shot = await run.shot(guest.page, 'guest-wingman-records');
      if (/wiki|gitea|mattermost|mailpit|calendar/i.test(`${text} ${sources}`)) {
        run.finding('ERROR', '/m/:id/room Wingman (guest)', `a guest's workspace question leaked a record source: "${text.slice(0, 240)}"`, shot);
      } else {
        run.pass(`Guest's workspace question stayed meeting-only (${shot}).`);
      }
    });
    await guest.context.close();
  } finally {
    run.save();
    await browser.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
