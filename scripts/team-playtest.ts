/// <reference lib="dom" />
/**
 * A simulated three-person team meeting: the owner plus Ana and Ben in separate Chrome windows.
 * People type their lines with the microphone off, so no real speech or AI voice is needed.
 *
 * The operator starts the stack separately. Run with `npm run playtest:team`; owner credentials come
 * from KAKI_PLAYTEST_OWNER_EMAIL / KAKI_PLAYTEST_OWNER_PASSWORD only when the server has sign-in on.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { KakiEvent, MeetingSetup, Task } from '@kaki/shared';
import { reportResultLine, statusFor, type PlaytestCheck } from './playtest-report';
import {
  judgeFollowUpTask,
  judgeMinutesRecipient,
  judgeSeatOptions,
  judgeTranscriptPresence,
  inviteCodeFromLink,
  ownerCredentials,
  pageShowsArtifact,
  practiceBusyIsPlain,
  seatRefusalIsPlain,
} from './team-playtest-helpers';

const BASE = (process.env.KAKI_PLAYTEST_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const LOG_DIR = '.live-logs';
const SHOT_DIR = join(LOG_DIR, 'team-playtest-shots');
type Check = PlaytestCheck;

export type TeamPlaytestOptions = { headless: boolean; maxMinutes: number };

type Actor = { name: string; context: BrowserContext; page: Page };

function options(): TeamPlaytestOptions {
  let headless = false;
  let maxMinutes = 20;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--headless') headless = true;
    else if (arg === '--max-minutes' && process.argv[i + 1] !== undefined) maxMinutes = Number(process.argv[++i]);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive');
  return { headless, maxMinutes };
}

function stamp(): string { return new Date().toISOString(); }
function escapeCell(value: string): string { return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

export async function runTeamPlaytest(parsed: TeamPlaytestOptions): Promise<{ reportPath: string; passed: boolean; summaryLines: string[] }> {
  const startedAt = new Date();
  const stem = `team-playtest-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const reportPath = join(LOG_DIR, `${stem}.md`);
  const checks: Check[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const shots: Array<{ at: string; path: string }> = [];
  const events: KakiEvent[] = [];
  let browser: Browser | undefined;
  let globalDeadline = Date.now() + parsed.maxMinutes * 60_000;
  let owner: Actor | undefined;
  let ana: Actor | undefined;
  let ben: Actor | undefined;
  let practice: Actor | undefined;
  let pageErrors = 0;
  let ownerRoleId = '';
  let anaRoleId = '';
  let benRoleId = '';
  let wikiConfigured: boolean | undefined;
  const muted = new Set<string>();

  async function keepShot(page: Page | undefined, name: string): Promise<string | undefined> {
    if (page === undefined || page.isClosed()) return undefined;
    await mkdir(SHOT_DIR, { recursive: true });
    const path = join(SHOT_DIR, `${stem}-${String(shots.length + 1).padStart(2, '0')}-${name.replace(/\W+/g, '-')}.png`);
    try {
      await page.screenshot({ path, timeout: 5_000 });
      shots.push({ at: stamp(), path });
      return path;
    } catch (error) {
      notes.push(`${stamp()} Screenshot failed (${name}): ${String(error)}`);
      return undefined;
    }
  }

  async function check(name: string, ok: boolean, detail: string, page?: Page, severity: 'fail' | 'warn' = 'fail'): Promise<void> {
    const item: Check = { at: stamp(), name, status: statusFor(ok, severity), detail };
    if (item.status === 'FAIL') item.shot = await keepShot(page, name);
    checks.push(item);
    console.log(`${item.status} ${name}: ${detail}`);
  }

  function notExercised(name: string, detail: string): void {
    const item: Check = { at: stamp(), name, status: 'NOT EXERCISED', detail };
    checks.push(item);
    console.log(`${item.status} ${name}: ${detail}`);
  }

  async function waitFor(name: string, predicate: () => boolean | Promise<boolean>, milliseconds: number, page?: Page, report = true): Promise<boolean> {
    const end = Math.min(Date.now() + milliseconds, globalDeadline);
    let problem = '';
    while (Date.now() < end) {
      try {
        if (await predicate()) return true;
      } catch (error) {
        problem = String(error);
      }
      await delay(400);
    }
    if (report) await check(name, false, `Timed out after ${milliseconds / 1000}s${problem === '' ? '' : `; last error: ${problem}`}`, page);
    return false;
  }

  function bodyText(page: Page): Promise<string> {
    return page.locator('body').innerText().catch(() => '');
  }

  async function muteMicrophone(page: Page, who: string): Promise<boolean> {
    const microphone = page.getByRole('button', { name: 'Microphone', exact: true });
    if (await microphone.count() === 0) return false;
    if (await microphone.getAttribute('aria-pressed').catch(() => null) === 'true') {
      await microphone.click({ timeout: 5_000 });
    }
    const mutedNow = await microphone.getAttribute('aria-pressed').catch(() => null) === 'false';
    if (mutedNow) muted.add(who);
    return mutedNow;
  }

  function transcriptEvents(): string[] {
    return events.flatMap((event) => (event.type === 'TRANSCRIPT_CHUNK' ? [event.payload.text.trim()] : []));
  }

  function currentTasks(): Map<string, Task> {
    const tasks = new Map<string, Task>();
    for (const event of events) {
      if (event.type === 'TASK_UPDATED') tasks.set(event.payload.task.id, event.payload.task);
    }
    return tasks;
  }

  function notetakerStatus(): string | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type === 'MEETING_RECORD_UPDATED' && event.payload.notetakerStatus !== undefined) {
        return event.payload.notetakerStatus;
      }
    }
    return undefined;
  }

  function minutesTask(): Task | undefined {
    return [...currentTasks().values()].find((task) => task.purpose === 'meeting_minutes');
  }

  function watchScreenEvents(page: Page): void {
    page.on('websocket', (socket) => {
      if (!socket.url().includes('/ws?audience=screen')) return;
      socket.on('framereceived', (frame) => {
        try {
          const raw = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
          events.push(JSON.parse(raw) as KakiEvent);
        } catch (error) {
          errors.push(`${stamp()} /ws frame parse: ${String(error)}`);
        }
      });
    });
  }

  async function newActor(name: string): Promise<Actor> {
    if (browser === undefined) throw new Error('Browser is not open');
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ['microphone', 'camera'],
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', (error) => {
      pageErrors += 1;
      errors.push(`${stamp()} ${name} page error: ${error.message}`);
    });
    if (name === 'Owner') watchScreenEvents(page);
    return { name, context, page };
  }

  async function serverAuthEnabled(page: Page): Promise<boolean> {
    const response = await page.request.get(`${BASE}/api/auth/me`, { timeout: 10_000 });
    const body = await response.json().catch(() => null) as { authEnabled?: unknown } | null;
    return body?.authEnabled === true;
  }

  async function ownerSignIn(): Promise<{ ok: true } | { ok: false; message: string }> {
    if (owner === undefined) return { ok: false, message: 'The owner window was not opened' };
    const authOn = await serverAuthEnabled(owner.page);
    const credentials = ownerCredentials(process.env, authOn);
    if (!credentials.ok) {
      await check('Owner credentials for sign-in', false, credentials.message, owner.page);
      return { ok: false, message: credentials.message };
    }
    if (!authOn) {
      notes.push(`${stamp()} Sign-in is off on this server; the owner went straight to setup`);
      return { ok: true };
    }
    const email = owner.page.getByLabel('Email');
    await email.waitFor({ state: 'visible', timeout: 20_000 });
    await email.fill(credentials.email ?? '');
    await owner.page.getByLabel('Password').fill(credentials.password ?? '');
    await owner.page.getByRole('button', { name: 'Sign in' }).click();
    const signedIn = await waitFor('Owner sign-in', async () => {
      return new URL(owner!.page.url()).pathname === '/setup';
    }, 20_000, owner.page, false);
    if (signedIn) await check('Owner signed in', true, 'Signed in as the meeting host');
    return signedIn ? { ok: true } : { ok: false, message: 'Sign-in did not reach the setup page' };
  }

  async function fillBlankPlan(page: Page, title: string, topics: [string, string]): Promise<void> {
    await page.getByRole('button', { name: 'Start a blank meeting' }).click({ timeout: 10_000 });
    const replace = page.getByRole('button', { name: 'Replace with a blank plan' });
    const needsReplace = await replace.waitFor({ state: 'visible', timeout: 1_500 }).then(() => true).catch(() => false);
    if (needsReplace) await replace.click({ timeout: 5_000 });
    const titleField = page.getByLabel('Meeting title field');
    await titleField.waitFor({ state: 'visible', timeout: 20_000 });
    // The editor is locked while the server replaces the draft; wait for the blank plan itself
    // before typing, so an arriving plan cannot overwrite the title and fields below.
    const blankReady = await waitFor('Blank plan is ready to edit', async () => {
      if (!await titleField.isEditable().catch(() => false)) return false;
      if (await titleField.inputValue().catch(() => null) !== '') return false;
      return await replace.count() === 0;
    }, 20_000, page, false);
    if (!blankReady) throw new Error('The blank plan was not ready to edit');
    await titleField.fill(title);

    const roles = ['Owner', 'Ana', 'Ben'];
    for (let index = 0; index < roles.length; index += 1) {
      await page.getByRole('button', { name: 'Add role' }).click({ timeout: 5_000 });
      await page.getByLabel(`Role ${index + 1} name`).fill(roles[index]!);
    }
    for (let index = 0; index < topics.length; index += 1) {
      await page.getByRole('button', { name: 'Add agenda item' }).click({ timeout: 5_000 });
    }
    await page.getByLabel('Agenda item 1 title').fill(topics[0]);
    await page.getByLabel('Agenda item 2 title').fill(topics[1]);
    await page.getByLabel('Agenda item 1 minutes').fill('5');
    await page.getByLabel('Agenda item 2 minutes').fill('5');
    await page.getByLabel('Agenda item 1 owner').selectOption({ label: 'Owner' });
    await page.getByLabel('Agenda item 2 owner').selectOption({ label: 'Ana' });
    for (let index = 0; index < roles.length; index += 1) {
      await page.getByRole('button', { name: 'Add seat' }).click({ timeout: 5_000 });
      await page.getByLabel(`Seat ${index + 1} name`).fill(roles[index]!);
      await page.getByLabel(`Seat ${index + 1} role`).selectOption({ label: roles[index]! });
    }
  }

  async function saveAndReadSetup(page: Page, title: string): Promise<MeetingSetup | undefined> {
    await page.getByRole('button', { name: 'Save setup' }).click({ timeout: 10_000 });
    const saved = await waitFor('Setup saved', async () => {
      const response = await page.request.get(`${BASE}/api/setup`, { timeout: 10_000 });
      if (!response.ok()) return false;
      const body = await response.json().catch(() => null) as { setup?: MeetingSetup } | null;
      return body?.setup !== undefined && body.setup.title === title && body.setup.roles.length === 3;
    }, 20_000, page, false);
    if (!saved) return undefined;
    const response = await page.request.get(`${BASE}/api/setup`, { timeout: 10_000 });
    const body = await response.json().catch(() => null) as { setup?: MeetingSetup } | null;
    return body?.setup;
  }

  async function joinOwner(page: Page): Promise<boolean> {
    await page.getByRole('heading', { name: 'Open your meeting room' }).waitFor({ state: 'visible', timeout: 20_000 });
    const micOff = await muteMicrophone(page, 'Owner');
    await check('Owner microphone is off', micOff, micOff ? 'Owner joins to type' : 'The Microphone control was missing or still on', page);
    await page.getByLabel('Your name').fill('Owner');
    await page.getByLabel('Your seat').selectOption({ label: 'Owner' });
    await page.getByRole('button', { name: 'Join the meeting room' }).click({ timeout: 10_000 });
    return waitFor('Owner joins their own room', async () => await page.locator('.kd-meeting').count() > 0, 25_000, page);
  }

  async function openInvite(actor: Actor, link: string): Promise<boolean> {
    await actor.page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    return waitFor(`${actor.name} opens the invite link`, async () => {
      return await actor.page.getByRole('heading', { name: 'Join the meeting' }).isVisible().catch(() => false);
    }, 20_000, actor.page);
  }

  async function submitJoin(page: Page): Promise<void> {
    const typed = page.getByRole('button', { name: 'Join to type' });
    if (await typed.count() > 0) await typed.click({ timeout: 10_000 });
    else await page.getByRole('button', { name: 'Join', exact: true }).click({ timeout: 10_000 });
  }

  async function joinParticipant(actor: Actor, seat: string): Promise<boolean> {
    const micOff = await muteMicrophone(actor.page, actor.name);
    await check(`${actor.name} microphone is off`, micOff, micOff ? `${actor.name} joins to type` : 'The Microphone control was missing or still on', actor.page);
    await actor.page.getByLabel('Your name').fill(actor.name);
    await actor.page.getByLabel('Your seat').selectOption({ label: seat });
    await submitJoin(actor.page);
    return waitFor(`${actor.name} joins`, async () => await actor.page.locator('.kd-meeting').count() > 0, 25_000, actor.page);
  }

  async function typeLine(actor: Actor, text: string): Promise<boolean> {
    try {
      const input = actor.page.getByRole('textbox', { name: 'Type to the meeting' });
      await input.fill(text, { timeout: 8_000 });
      await input.press('Enter', { timeout: 8_000 });
      const landed = await waitFor(`${actor.name}'s line reached the transcript`, () =>
        transcriptEvents().includes(text.trim()), 20_000, actor.page, false);
      await delay(500);
      return landed;
    } catch (error) {
      notes.push(`${stamp()} ${actor.name} could not type: ${String(error)}`);
      return false;
    }
  }

  async function openTranscript(actor: Actor): Promise<void> {
    const details = actor.page.locator('details.kd-transcript-drawer').first();
    if (await details.count() === 0) return;
    if (await details.getAttribute('open') === null) {
      await details.locator('summary').click({ timeout: 5_000 }).catch(() => undefined);
    }
  }

  async function checkTranscript(actor: Actor, expected: readonly string[]): Promise<void> {
    const drawer = actor.page.locator('details.kd-transcript-drawer');
    if (await drawer.count() === 0) {
      await check(`${actor.name}'s transcript shows each line once`, false, 'The page had no transcript drawer', actor.page);
      return;
    }
    await openTranscript(actor);
    const selector = 'details.kd-transcript-drawer li[data-kind="said"] > span';
    const ready = await waitFor(`${actor.name}'s transcript has the lines`, async () => {
      const lines = (await actor.page.locator(selector).allTextContents()).map((line) => line.trim());
      return expected.every((line) => lines.includes(line.trim()));
    }, 20_000, actor.page, false);
    if (!ready) {
      await check(`${actor.name}'s transcript shows each line once`, false,
        `The transcript drawer did not show all ${expected.length} typed lines`, actor.page);
      return;
    }
    const lines = (await actor.page.locator(selector).allTextContents()).map((line) => line.trim());
    const verdict = judgeTranscriptPresence(expected, { [actor.name]: lines });
    await check(`${actor.name}'s transcript shows each line once`, verdict.ok, verdict.detail, actor.page);
  }

  async function toolConfigured(kind: string): Promise<boolean | undefined> {
    if (owner === undefined) return undefined;
    const response = await owner.page.request.get(`${BASE}/api/setup/tools`, { timeout: 10_000 }).catch(() => undefined);
    if (response === undefined || !response.ok()) return undefined;
    const body = await response.json().catch(() => null) as { tools?: Array<{ kind?: unknown; configured?: unknown }> } | null;
    const tool = body?.tools?.find((candidate) => candidate.kind === kind);
    return typeof tool?.configured === 'boolean' ? tool.configured : undefined;
  }

  try {
    globalDeadline = Date.now() + parsed.maxMinutes * 60_000;
    await mkdir(LOG_DIR, { recursive: true });
    browser = await chromium.launch({
      channel: 'chrome',
      headless: parsed.headless,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        ...(process.env.KAKI_PLAYTEST_SOUND === '1' ? [] : ['--mute-audio']),
      ],
    });

    owner = await newActor('Owner');
    ana = await newActor('Ana');
    ben = await newActor('Ben');
    practice = await newActor('Practice visitor');

    // 1. Landing page: both paths and the invite-code box.
    await owner.page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const runLink = owner.page.getByRole('link', { name: 'Run a team meeting', exact: true });
    const practiceLink = owner.page.getByRole('link', { name: 'Try a practice meeting', exact: true });
    const codeBox = owner.page.locator('#invite-code');
    const runLinkVisible = await runLink.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
    const landingOk = runLinkVisible && await runLink.count() === 1 && await practiceLink.count() === 1 && await codeBox.count() === 1;
    await check('Landing shows both choices and the code box', landingOk,
      `Run a team meeting link: ${await runLink.count()}; practice link: ${await practiceLink.count()}; code box: ${await codeBox.count()}`,
      owner.page);
    const signInOn = await serverAuthEnabled(owner.page);
    notes.push(`${stamp()} Sign-in on this server: ${signInOn ? 'yes' : 'no'}`);

    // 2. Owner: landing -> sign-in when on -> setup -> blank plan -> open the room.
    const title = 'Team playtest meeting';
    const topics: [string, string] = ['Supplier tray sizes', 'Friday delivery plan'];
    const toSetup = await Promise.all([
      owner.page.waitForURL(/\/(?:login|setup)(?:\?.*)?$/, { timeout: 20_000 }).then(() => true).catch(() => false),
      runLink.click({ timeout: 10_000 }).then(() => true).catch(() => false),
    ]);
    await check('Run a team meeting opens sign-in or setup', toSetup[0] && toSetup[1],
      `Owner page is ${new URL(owner.page.url()).pathname}`, owner.page);
    if (new URL(owner.page.url()).pathname === '/login') {
      const signedIn = await ownerSignIn();
      if (!signedIn.ok) throw new Error(signedIn.message);
    }
    await waitFor('Setup page loaded', () => new URL(owner!.page.url()).pathname === '/setup', 20_000, owner.page);
    await fillBlankPlan(owner.page, title, topics);
    const setup = await saveAndReadSetup(owner.page, title);
    if (setup === undefined) throw new Error('The blank plan was not saved');
    const ownerRole = setup.roles.find((role) => role.label === 'Owner');
    const anaRole = setup.roles.find((role) => role.label === 'Ana');
    const benRole = setup.roles.find((role) => role.label === 'Ben');
    if (ownerRole === undefined || anaRole === undefined || benRole === undefined) {
      throw new Error('The saved plan does not have the three roles it needs');
    }
    ownerRoleId = ownerRole.id;
    anaRoleId = anaRole.id;
    benRoleId = benRole.id;
    const slug = (value: string): string => value.trim().toLowerCase();
    const planOk =
      setup.title === title &&
      setup.agenda.length === 2 &&
      setup.agenda[0]?.title === topics[0] &&
      setup.agenda[1]?.title === topics[1] &&
      setup.agenda[0]?.ownerRoleId === ownerRoleId &&
      setup.agenda[1]?.ownerRoleId === anaRoleId &&
      setup.roles.length === 3 &&
      setup.seats.length === 3 &&
      setup.seats.every((seat) => seat.kind === 'person') &&
      setup.seats.every((seat, index) => slug(seat.displayName) === slug(['Owner', 'Ana', 'Ben'][index] ?? ''));
    await check('Blank plan filled with a title, two agenda items, three roles and three person seats', planOk,
      `${setup.title}; agenda ${setup.agenda.map((item) => item.title).join(' / ')}; roles ${setup.roles.map((role) => role.label).join(' / ')}; seats ${setup.seats.map((seat) => `${seat.displayName}:${seat.kind}`).join(' / ')}`,
      owner.page);
    wikiConfigured = await toolConfigured('wiki_page');
    notes.push(`${stamp()} Team wiki tool configured: ${wikiConfigured === undefined ? 'unknown' : wikiConfigured ? 'yes' : 'no'}`);

    const openRoom = owner.page.getByRole('button', { name: 'Open the meeting room' });
    const openEnabled = await waitFor('Open the meeting room becomes enabled', () => openRoom.isEnabled(), 20_000, owner.page);
    await check('Open the meeting room is enabled', openEnabled, openEnabled ? 'The saved plan is valid' : 'The button stayed disabled', owner.page);
    if (!openEnabled) throw new Error('The saved plan never enabled Open the meeting room');
    await openRoom.click({ timeout: 10_000 });
    await waitFor('Owner reaches the meeting room', () => new URL(owner!.page.url()).pathname === '/meeting', 20_000, owner.page);

    // 3. Owner joins their own seat and reads the invite link from the lobby.
    if (!await joinOwner(owner.page)) throw new Error('The owner could not join their own seat');
    const lobby = owner.page.getByRole('region', { name: 'Meeting lobby' });
    const lobbyOk = await waitFor('Owner lobby appears', () => lobby.isVisible(), 20_000, owner.page);
    if (!lobbyOk) throw new Error('The owner lobby did not appear');
    const inviteAnchor = lobby.locator('.kd-lobby-link a').first();
    await inviteAnchor.waitFor({ state: 'visible', timeout: 20_000 });
    const inviteHref = (await inviteAnchor.getAttribute('href')) ?? '';
    const inviteCode = inviteCodeFromLink(inviteHref);
    const shownCode = ((await lobby.locator('.kd-lobby-actions strong').first().textContent()) ?? '').trim();
    await check('Owner lobby shows the invite link and code', inviteCode !== undefined && shownCode !== '' && inviteCode === shownCode,
      `Invite link ${inviteHref}; code shown ${shownCode}`, owner.page);
    if (inviteCode === undefined) throw new Error(`The lobby link is not an invite link: ${inviteHref}`);

    // 4. Ana and Ben open the invite link: code prefilled, person seats only, no Kopitiam story.
    const seatLabels = ['Owner', 'Ana', 'Ben'];
    if (!await openInvite(ana, inviteHref)) throw new Error('Ana could not open the invite link');
    const anaCode = await ana.page.getByLabel('Meeting code').inputValue().catch(() => '');
    const anaSeats = await ana.page.getByLabel('Your seat').locator('option').allTextContents();
    const anaSeatVerdict = judgeSeatOptions(anaSeats, seatLabels);
    const anaStoryText = await bodyText(ana.page);
    const anaStoryOk = !/Kopitiam/i.test(anaStoryText) && !/AI colleagues/i.test(anaStoryText);
    await check('Ana sees the invite code prefilled', anaCode.trim() === inviteCode, `Code box shows "${anaCode.trim()}"`, ana.page);
    await check('Ana sees only the meeting person seats', anaSeatVerdict.ok, anaSeatVerdict.detail, ana.page);
    await check('Ana sees no Kopitiam story on the team join page', anaStoryOk,
      anaStoryOk ? 'No Kopitiam or AI-colleagues story text on the team join form' : 'The join page carried practice story text', ana.page);
    if (!await joinParticipant(ana, 'Ana')) throw new Error('Ana could not join');
    const anaWaiting = await waitFor('Ana waits for the owner to start', async () =>
      await ana!.page.getByRole('region', { name: 'Waiting for the meeting to start' }).isVisible().catch(() => false),
    20_000, ana.page);
    const anaWaitingText = await bodyText(ana.page);
    const anaNoStart = await ana.page.getByRole('button', { name: 'Start the meeting' }).count() === 0;
    await check('Ana sees the waiting message and no Start button', anaWaiting && /Waiting for the meeting owner to start/i.test(anaWaitingText) && anaNoStart,
      `Waiting region: ${anaWaiting}; Start buttons: ${anaNoStart ? 0 : 1}`, ana.page);

    if (!await openInvite(ben, inviteHref)) throw new Error('Ben could not open the invite link');
    const benCode = await ben.page.getByLabel('Meeting code').inputValue().catch(() => '');
    const benSeats = await ben.page.getByLabel('Your seat').locator('option').allTextContents();
    const benSeatVerdict = judgeSeatOptions(benSeats, seatLabels);
    await check('Ben sees the invite code prefilled', benCode.trim() === inviteCode, `Code box shows "${benCode.trim()}"`, ben.page);
    await check('Ben sees only the meeting person seats', benSeatVerdict.ok, benSeatVerdict.detail, ben.page);

    // 5. Ben tries Ana's seat first: a plain refusal, then he picks his own.
    await muteMicrophone(ben.page, 'Ben');
    await ben.page.getByLabel('Your name').fill('Ben');
    await ben.page.getByLabel('Your seat').selectOption({ label: 'Ana' });
    await submitJoin(ben.page);
    const refusal = await waitFor('Ben refuses Ana\'s seat', async () => {
      const alert = ben!.page.getByRole('alert').first();
      return await alert.isVisible().catch(() => false);
    }, 20_000, ben.page, false);
    const refusalText = refusal ? ((await ben.page.getByRole('alert').first().textContent()) ?? '').trim() : '';
    await check('A seat conflict is refused with a plain message', seatRefusalIsPlain(refusalText), refusalText === '' ? 'No refusal message appeared' : refusalText, ben.page);
    await ben.page.getByLabel('Your seat').selectOption({ label: 'Ben' });
    if (!await joinParticipant(ben, 'Ben')) throw new Error('Ben could not join after the seat refusal');
    const benWaiting = await waitFor('Ben waits for the owner to start', async () =>
      await ben!.page.getByRole('region', { name: 'Waiting for the meeting to start' }).isVisible().catch(() => false),
    20_000, ben.page);
    await check('Ben sees the waiting message and no Start button',
      benWaiting && await ben.page.getByRole('button', { name: 'Start the meeting' }).count() === 0,
      `Waiting region: ${benWaiting}`, ben.page);

    // 6. Practice is plainly blocked while the team meeting is open.
    await practice.page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await practice.page.getByRole('heading', { name: 'Join meeting' }).waitFor({ state: 'visible', timeout: 20_000 });
    const practiceMicOff = await muteMicrophone(practice.page, 'Practice visitor');
    await check('Practice visitor microphone is off', practiceMicOff, practiceMicOff ? 'The visitor joins to type' : 'The Microphone control was missing or still on', practice.page);
    await practice.page.getByLabel('Your name').fill('Practice visitor');
    await submitJoin(practice.page);
    const practiceBlocked = await waitFor('Practice is refused while the team meeting runs', async () =>
      await practice!.page.getByRole('alert').first().isVisible().catch(() => false), 20_000, practice.page, false);
    const practiceBlockedText = practiceBlocked ? ((await practice.page.getByRole('alert').first().textContent()) ?? '').trim() : '';
    await check('Practice says the team meeting is in progress', practiceBusyIsPlain(practiceBlockedText),
      practiceBlockedText === '' ? 'No practice refusal message appeared' : practiceBlockedText, practice.page);

    // 7. Owner's lobby lists the two arrivals; only the owner has the lobby.
    const lobbyLists = await waitFor('Owner lobby lists Ana and Ben', async () => {
      const texts = await owner!.page.locator('.kd-lobby-people li').allTextContents();
      const joined = texts.join(' | ');
      return joined.includes('Ana') && joined.includes('Ben');
    }, 25_000, owner.page, false);
    const lobbyTexts = await owner.page.locator('.kd-lobby-people li').allTextContents();
    const anaNoLobby = await ana.page.locator('.kd-lobby-people').count() === 0;
    const benNoLobby = await ben.page.locator('.kd-lobby-people').count() === 0;
    await check('Owner-only lobby lists Ana and Ben', lobbyLists && anaNoLobby && benNoLobby,
      `Owner list: ${lobbyTexts.map((line) => line.trim()).join(' / ') || '(empty)'}; Ana lobby: ${anaNoLobby ? 'none' : 'present'}; Ben lobby: ${benNoLobby ? 'none' : 'present'}`,
      owner.page);

    const startButton = owner.page.getByRole('button', { name: 'Start the meeting' });
    await startButton.click({ timeout: 10_000 });
    const ownerStarted = await waitFor('Owner leaves the lobby', async () =>
      await owner!.page.locator('.kd-meeting[data-needs-start="false"]').count() > 0, 20_000, owner.page);
    const anaStarted = await waitFor('Ana leaves the waiting room', async () =>
      await ana!.page.locator('.kd-meeting[data-needs-start="false"]').count() > 0 &&
      await ana!.page.getByRole('region', { name: 'Waiting for the meeting to start' }).count() === 0,
    20_000, ana.page);
    const benStarted = await waitFor('Ben leaves the waiting room', async () =>
      await ben!.page.locator('.kd-meeting[data-needs-start="false"]').count() > 0 &&
      await ben!.page.getByRole('region', { name: 'Waiting for the meeting to start' }).count() === 0,
    20_000, ben.page);
    await check('Owner Start leaves all three out of the waiting state', ownerStarted && anaStarted && benStarted,
      `Owner: ${ownerStarted}; Ana: ${anaStarted}; Ben: ${benStarted}`, owner.page);

    // 8. Each person types one line about the first agenda item; every transcript shows all three once.
    const lines = [
      `For ${topics[0]}, I will confirm the stock count before lunch.`,
      `On ${topics[0]}, I can check the supplier list this afternoon.`,
      `For ${topics[0]}, I will ask about the delivery slot.`,
    ];
    const typedOwner = await typeLine(owner, lines[0]!);
    await check("Owner's line is recorded", typedOwner, lines[0]!, owner.page);
    const typedAna = await typeLine(ana, lines[1]!);
    await check("Ana's line is recorded", typedAna, lines[1]!, ana.page);
    const typedBen = await typeLine(ben, lines[2]!);
    await check("Ben's line is recorded", typedBen, lines[2]!, ben.page);
    await checkTranscript(owner, lines);
    await checkTranscript(ana, lines);
    await checkTranscript(ben, lines);

    // 9. A follow-up clearly for Ana reaches her Wingman panel and not Ben's.
    const followUp = 'Ana, please email the supplier the new tray sizes by Friday.';
    const followUpLanded = await typeLine(owner, followUp);
    await check('Owner types the follow-up for Ana', followUpLanded, followUp, owner.page);
    const cardSeen = await waitFor('A follow-up card is produced', () => {
      if (notetakerStatus() === 'off') return true;
      return [...currentTasks().values()].some((task) =>
        task.purpose !== 'meeting_minutes' &&
        task.status !== 'DISMISSED' &&
        task.status !== 'SUPERSEDED' &&
        (task.assignee === anaRoleId || task.suggestedAssignee === anaRoleId));
    }, 75_000, owner.page, false);
    const allNewTasks = [...currentTasks().values()].filter((task) =>
      task.purpose !== 'meeting_minutes' && task.status !== 'DISMISSED' && task.status !== 'SUPERSEDED');
    const anaTask = allNewTasks.find((task) => task.assignee === anaRoleId || task.suggestedAssignee === anaRoleId);
    const taskOutcome = judgeFollowUpTask(cardSeen && anaTask !== undefined, notetakerStatus());
    const taskDetail = anaTask === undefined
      ? `${taskOutcome.detail}. Cards seen: ${allNewTasks.map((task) => `${task.title} (${task.assignee ?? task.suggestedAssignee ?? 'no seat'})`).join(' / ') || '(none)'}`
      : `${anaTask.title} assigned to ${anaTask.assignee ?? anaTask.suggestedAssignee} (${anaTask.status})`;
    if (taskOutcome.status === 'PASS') {
      await check('Follow-up task reaches Ana', true, taskDetail, ana.page);
    } else if (taskOutcome.status === 'NOT EXERCISED') {
      notExercised('Follow-up task reaches Ana', taskDetail);
    } else {
      await check('Follow-up task reaches Ana', false, taskDetail, ana.page);
    }
    let accepted = false;
    if (anaTask !== undefined) {
      const anaPanel = ana.page.locator('.kd-role-active');
      const accept = anaPanel.getByRole('button', { name: /^Accept ·/ }).first();
      const approve = anaPanel.getByRole('button', { name: 'Approve & publish' }).first();
      const acceptVisible = await accept.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
      const approveVisible = acceptVisible ? false : await approve.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false);
      const benPanel = ben.page.locator('.kd-role-active');
      const benText = await benPanel.count() > 0 ? await benPanel.first().innerText().catch(() => '') : '';
      const benHasTask = benText.includes(anaTask.title);
      await check("The follow-up does not reach Ben's Wingman panel", !benHasTask,
        benHasTask ? `Ben's panel showed ${anaTask.title}` : 'Ben had no card for the follow-up', ben.page);
      await check("The follow-up reaches Ana's Wingman panel", acceptVisible || approveVisible,
        acceptVisible ? 'Ana had an Accept control for the card' : approveVisible ? 'Ana had an Approve control for an already-drafted card' : "Ana's panel showed no control for the card",
        ana.page);
      if (acceptVisible) {
        await accept.click({ timeout: 5_000 });
        accepted = await waitFor('Ana accepts the follow-up', () => {
          const task = currentTasks().get(anaTask.id);
          return task !== undefined && ['CLAIMED', 'RUNNING', 'DRAFT_READY', 'COMPLETED', 'SYNCED'].includes(task.status);
        }, 25_000, ana.page, false);
        await check('Ana can accept the follow-up', accepted,
          accepted ? `Card ${anaTask.id} moved past DISPATCHED` : `Card ${anaTask.id} stayed DISPATCHED`, ana.page);
      } else if (approveVisible) {
        accepted = true;
        await check('Ana can accept the follow-up', true, `Card ${anaTask.id} was already drafted for Ana`, ana.page);
      } else {
        await check('Ana can accept the follow-up', false, "Ana's panel showed no Accept or Approve control", ana.page);
      }
    } else {
      notExercised('The follow-up does not reach Ben', 'No follow-up card was produced, so routing to Ben could not be checked');
      notExercised('Ana can accept the follow-up', 'No follow-up card was produced, so there was nothing to accept');
    }

    // 10. Owner ends the meeting; the minutes card must go to the owner for approval.
    const ownerEnd = owner.page.getByRole('button', { name: 'End meeting' }).first();
    await ownerEnd.click({ timeout: 10_000 });
    const closing = await waitFor('Closing cue after End meeting', () =>
      events.some((event) => event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING'),
    20_000, owner.page);
    await check('Owner ends the meeting', closing, closing ? 'The closing cue reached the room' : 'No closing cue arrived', owner.page);

    if (wikiConfigured === false) {
      notExercised('Minutes card goes to the owner', 'Team wiki is not configured (wiki_page tool not connected), so the minutes card is not created');
      notExercised('Participants see the published minutes link', 'Team wiki is not configured, so no minutes can be published');
    } else {
      const minutes = await waitFor('Minutes card appears', () => minutesTask() !== undefined, 60_000, owner.page, false);
      const minutesNow = minutesTask();
      if (!minutes || minutesNow === undefined) {
        await check('Minutes card goes to the owner', false,
          `No minutes card appeared within 60s (wiki configured: ${wikiConfigured === undefined ? 'unknown' : 'yes'}; notetakerStatus ${notetakerStatus() ?? 'unknown'})`,
          owner.page);
        notExercised('Participants see the published minutes link', 'No minutes card appeared, so there was nothing to publish');
      } else {
        const verdict = judgeMinutesRecipient(minutesNow, ownerRoleId, [anaRoleId, benRoleId]);
        await check('Minutes card goes to the owner', verdict.ok, verdict.detail, owner.page);
        const minutesTitle = minutesNow.title;
        const ownerPanel = owner.page.locator('.kd-role-active');
        const ownerHasCard = await ownerPanel.count() > 0 &&
          (await ownerPanel.first().innerText().catch(() => '')).includes(minutesTitle);
        const anaPanelLocator = ana.page.locator('.kd-role-active');
        const benPanelLocator = ben.page.locator('.kd-role-active');
        const anaPanelText = await anaPanelLocator.count() > 0 ? await anaPanelLocator.first().innerText().catch(() => '') : '';
        const benPanelText = await benPanelLocator.count() > 0 ? await benPanelLocator.first().innerText().catch(() => '') : '';
        // The minutes card is the one named by its title. An Approve & publish control can belong
        // to the person's own follow-up card (Ana's email draft), so a bare button proves nothing.
        const anaHasMinutes = anaPanelText.includes(minutesTitle);
        const benHasMinutes = benPanelText.includes(minutesTitle);
        await check('Only the owner gets the minutes card for approval', ownerHasCard && !anaHasMinutes && !benHasMinutes,
          `Owner has card: ${ownerHasCard}; Ana: ${anaHasMinutes}; Ben: ${benHasMinutes}`, owner.page);
        if (verdict.ok) {
          const approve = ownerPanel.getByRole('button', { name: 'Approve & publish' }).first();
          const approveVisible = await approve.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true).catch(() => false);
          if (!approveVisible) {
            await check('Owner approves the minutes', false, 'The owner had no Approve & publish control for the minutes card', owner.page);
            notExercised('Participants see the published minutes link', 'The minutes card could not be approved');
          } else {
            await approve.click({ timeout: 5_000 });
            await waitFor('Minutes publish finishes', () => {
              const task = currentTasks().get(minutesNow.id);
              return task !== undefined && ['COMPLETED', 'SYNCED', 'FAILED'].includes(task.status);
            }, 60_000, owner.page, false);
            const finishedTask = currentTasks().get(minutesNow.id);
            const published = finishedTask?.status === 'COMPLETED' || finishedTask?.status === 'SYNCED';
            const publishFailed = finishedTask?.status === 'FAILED';
            const approveDetail = finishedTask === undefined
              ? 'The minutes card vanished'
              : `${finishedTask.status}${finishedTask.error === undefined ? '' : `: ${finishedTask.error}`}`;
            if (publishFailed) {
              await check('Owner approves the minutes', false, `The approval was sent but publishing failed: ${approveDetail}`, owner.page, 'warn');
            } else {
              await check('Owner approves the minutes', published, approveDetail, owner.page);
            }
            const artifact = finishedTask?.artifactUrl;
            if (artifact === undefined) {
              notExercised('Participants see the published minutes link',
                finishedTask?.error ?? 'The minutes were approved but the server returned no published link');
            } else {
              const anaText = await bodyText(ana.page);
              const benText = await bodyText(ben.page);
              const anaHrefs: string[] = [];
              const benHrefs: string[] = [];
              for (const anchor of await ana.page.locator('a').all()) anaHrefs.push((await anchor.getAttribute('href')) ?? '');
              for (const anchor of await ben.page.locator('a').all()) benHrefs.push((await anchor.getAttribute('href')) ?? '');
              await check('Ana sees the published minutes link', pageShowsArtifact(anaText, anaHrefs, artifact), `Artifact ${artifact}`, ana.page);
              await check('Ben sees the published minutes link', pageShowsArtifact(benText, benHrefs, artifact), `Artifact ${artifact}`, ben.page);
            }
          }
        } else {
          notExercised('Participants see the published minutes link', 'The minutes card did not reach the owner, so it could not be approved');
        }
      }
    }

    // 11. After the meeting, a new visitor can use practice again.
    for (const actor of [ana, ben, owner]) {
      if (actor === undefined) continue;
      await actor.context.close().catch((error: unknown) => notes.push(`${stamp()} Closing ${actor.name} failed: ${String(error)}`));
    }
    ana = undefined;
    ben = undefined;
    owner = undefined;
    const released = await waitFor('Team meeting releases the server for practice', async () => {
      const response = await practice!.page.request.get(`${BASE}/api/meeting/state`, { timeout: 10_000 }).catch(() => undefined);
      if (response === undefined || !response.ok()) return false;
      const body = await response.json().catch(() => null) as { kind?: unknown } | null;
      return body?.kind !== 'real';
    }, 180_000, practice.page, false);
    await check('Team meeting room is released after everyone leaves', released,
      released ? 'The server no longer reports a real meeting' : 'The server still reports a real meeting after 3 minutes', practice.page);
    await practice.page.goto(`${BASE}/practice`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await practice.page.getByRole('heading', { name: 'Join meeting' }).waitFor({ state: 'visible', timeout: 20_000 });
    const afterMicOff = await muteMicrophone(practice.page, 'After visitor');
    await check('After-visitor microphone is off', afterMicOff, afterMicOff ? 'The visitor joins to type' : 'The Microphone control was missing or still on', practice.page);
    await practice.page.getByLabel('Your name').fill('After visitor');
    await submitJoin(practice.page);
    const practiceJoined = await waitFor('Practice joins after the meeting', async () =>
      await practice!.page.locator('.kd-meeting').count() > 0, 30_000, practice.page, false);
    const afterAlert = practiceJoined ? '' : ((await practice.page.getByRole('alert').first().textContent().catch(() => '')) ?? '').trim();
    await check('Practice works again for a new visitor after the meeting', practiceJoined,
      practiceJoined ? 'The practice room opened for a new visitor' : afterAlert === '' ? 'The practice room did not open' : afterAlert,
      practice.page);

    await check('No uncaught page errors in any window', pageErrors === 0,
      pageErrors === 0 ? 'No pageerror events' : `${pageErrors} page error(s)`, practice.page);

    // Leave the server free for the next run: end the practice meeting the run just opened.
    const practiceAuthOn = await serverAuthEnabled(practice.page).catch(() => false);
    if (practiceAuthOn) {
      const credentials = ownerCredentials(process.env, true);
      if (credentials.ok) {
        await practice.page.request.post(`${BASE}/api/auth/login`, {
          data: { email: credentials.email, password: credentials.password },
          timeout: 10_000,
        }).catch(() => undefined);
      }
    }
    const practiceEnded = await practice.page.request.post(`${BASE}/api/meeting/end-practice`, { timeout: 10_000 }).catch(() => undefined);
    if (practiceEnded === undefined || !practiceEnded.ok()) {
      notes.push(`${stamp()} Could not end the practice meeting after the run (HTTP ${practiceEnded?.status() ?? 'no response'})`);
    }
  } catch (error) {
    await check('Team playtest flow', false, error instanceof Error ? error.stack ?? error.message : String(error),
      owner?.page ?? practice?.page ?? ana?.page ?? ben?.page);
  } finally {
    const uniqueTranscript = new Map<string, { at: string; speaker: string; text: string }>();
    for (const event of events) {
      if (event.type !== 'TRANSCRIPT_CHUNK') continue;
      const key = `${event.payload.timestamp}|${event.payload.speaker}|${event.payload.text}`;
      if (!uniqueTranscript.has(key)) {
        uniqueTranscript.set(key, { at: event.payload.timestamp, speaker: event.payload.speaker, text: event.payload.text });
      }
    }
    const taskLines = [...currentTasks().values()].map((task) =>
      `- ${task.id} · ${task.purpose ?? '(no purpose)'} · ${task.status} · ${task.title} · owner ${task.assignee ?? task.suggestedAssignee ?? '(none)'}${task.artifactUrl === undefined ? '' : ` · ${task.artifactUrl}`}`);
    const lines = [
      `# Kaki team meeting playtest — ${startedAt.toISOString()}`,
      '',
      `Base: ${BASE} · Owner seat: ${ownerRoleId || '(not set)'} · Ana seat: ${anaRoleId || '(not set)'} · Ben seat: ${benRoleId || '(not set)'} · ${parsed.headless ? 'Headless' : 'Headed'} · Duration: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`,
      `Mic-off people: ${[...muted].join(', ') || '(none)'}`,
      reportResultLine(checks),
      '',
      '| Time (UTC) | Check | Result | Detail | Screenshot |',
      '| --- | --- | --- | --- | --- |',
      ...checks.map((item) => `| ${item.at} | ${escapeCell(item.name)} | ${item.status} | ${escapeCell(item.detail)} | ${item.shot ?? ''} |`),
      '',
      '## Screenshots',
      '',
      ...(shots.length === 0 ? ['(none)'] : shots.map((shot) => `- ${shot.at} — ${shot.path}`)),
      '',
      '## API transcript seen in the owner window',
      '',
      ...(uniqueTranscript.size === 0
        ? ['(none)']
        : [...uniqueTranscript.values()].map((line) => `- ${line.at} **${line.speaker}:** ${line.text}`)),
      '',
      '## Tasks seen (latest state)',
      '',
      ...(taskLines.length === 0 ? ['(none)'] : taskLines),
      '',
      '## Notes',
      '',
      ...(notes.length === 0 ? ['(none)'] : notes.map((note) => `- ${note}`)),
      '',
      '## Errors',
      '',
      ...(errors.length === 0 ? ['(none)'] : errors.map((error) => `- ${error}`)),
    ];
    await mkdir(LOG_DIR, { recursive: true });
    await writeFile(reportPath, lines.join('\n'));
    for (const actor of [ana, ben, owner, practice]) {
      if (actor !== undefined) await actor.context.close().catch(() => undefined);
    }
    if (browser !== undefined) await browser.close().catch((error: unknown) => console.error(`Could not close Chrome: ${String(error)}`));
  }
  const summaryLines = [
    `Report: ${reportPath}`,
    `Result: ${checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS'}`,
  ];
  for (const line of summaryLines) console.log(line);
  return { reportPath, passed: checks.every((item) => item.status !== 'FAIL'), summaryLines };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = options();
  void runTeamPlaytest(parsed).then((result) => {
    process.exitCode = result.passed ? 0 : 1;
  });
}
