/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
// The fake speaker reads the LiveKit keys from the repo's .env, like the runner does.
import '../../server/src/env';
import { createFakeSpeaker } from '../../server/src/npc/fakeStt';

export const BASE = 'http://localhost:5173';
export const ROOT = process.cwd();
export const LOG_DIR = resolve(ROOT, '.live-logs/clickthrough');

/** The one cross-process lock the journeys share, so parallel runs never exhaust the meeting caps. */
const JOURNEY_LOCK_DIR = resolve(LOG_DIR, '.journey-lock');
const JOURNEY_LOCK_WAIT_MS = 45 * 60_000;
const JOURNEY_LOCK_POLL_MS = 2_000;
const JOURNEY_LOCK_STALE_MS = 60 * 60_000;

interface JourneyLockOwner {
  journey: string;
  pid: number;
  at: string;
}

function readJourneyLock(): JourneyLockOwner | undefined {
  try {
    return JSON.parse(readFileSync(resolve(JOURNEY_LOCK_DIR, 'owner.json'), 'utf8')) as JourneyLockOwner;
  } catch {
    return undefined;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseJourneyLock(): void {
  rmSync(JOURNEY_LOCK_DIR, { recursive: true, force: true });
}

/**
 * Run one journey while holding the shared journey lock. The click-through meetings count toward the
 * server's open-meeting caps, so starting every journey at once can make a practice or real meeting
 * fail with "busy". Serialising the journeys keeps every run well inside the caps the product ships.
 */
export async function withJourneyLock<T>(journey: string, run: () => Promise<T>): Promise<T> {
  mkdirSync(LOG_DIR, { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(JOURNEY_LOCK_DIR);
      writeFileSync(
        resolve(JOURNEY_LOCK_DIR, 'owner.json'),
        JSON.stringify({ journey, pid: process.pid, at: new Date().toISOString() } satisfies JourneyLockOwner),
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = readJourneyLock();
      const age = owner === undefined
        ? Date.now() - statSync(JOURNEY_LOCK_DIR).mtimeMs
        : Date.now() - Date.parse(owner.at);
      const stale = age > JOURNEY_LOCK_STALE_MS || (owner !== undefined && !processIsRunning(owner.pid));
      if (stale) {
        releaseJourneyLock();
        continue;
      }
      if (Date.now() - started > JOURNEY_LOCK_WAIT_MS) {
        throw new Error(
          `click-through journeys run one at a time, and ${owner?.journey ?? 'another journey'} has held the lock for over 45 minutes`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, JOURNEY_LOCK_POLL_MS));
    }
  }
  const release = (): void => releaseJourneyLock();
  process.once('exit', release);
  console.log(`click-through journey ${journey}: running alone (journeys are serialised to stay inside the meeting caps)`);
  try {
    return await run();
  } finally {
    process.removeListener('exit', release);
    release();
  }
}

export type FindingKind = 'ERROR' | 'DEAD-END' | 'CONFUSING' | 'LAYOUT' | 'SLOW';

interface Finding {
  kind: FindingKind;
  where: string;
  what: string;
  shot?: string;
}

/** One journey run: screenshots, findings, passes and a findings file at the end. */
export class Run {
  readonly dir: string;
  private shotNo = 0;
  private readonly findings: Finding[] = [];
  private readonly passes: string[] = [];
  private readonly notes: string[] = [];
  private readonly consoleErrors: string[] = [];
  private readonly pageErrors: string[] = [];
  private readonly badRequests: string[] = [];

  constructor(readonly journey: string) {
    this.dir = resolve(LOG_DIR, journey);
    mkdirSync(this.dir, { recursive: true });
  }

  async shot(page: Page, name: string): Promise<string> {
    this.shotNo += 1;
    const file = `${String(this.shotNo).padStart(2, '0')}-${name}.png`;
    await page.screenshot({ path: resolve(this.dir, file) });
    return file;
  }

  finding(kind: FindingKind, where: string, what: string, shot?: string): void {
    this.findings.push({ kind, where, what, ...(shot === undefined ? {} : { shot }) });
  }

  pass(what: string): void {
    this.passes.push(what);
  }

  note(what: string): void {
    this.notes.push(what);
  }

  consoleError(text: string): void {
    if (this.consoleErrors.includes(text)) return;
    this.consoleErrors.push(text);
  }

  pageError(text: string): void {
    if (this.pageErrors.includes(text)) return;
    this.pageErrors.push(text);
  }

  badRequest(text: string): void {
    if (this.badRequests.includes(text)) return;
    this.badRequests.push(text);
  }

  /** Run an action and record a SLOW finding when it takes more than 10 s. */
  async timed<T>(where: string, action: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const result = await action();
    const ms = Date.now() - started;
    if (ms > 10_000) {
      this.finding('SLOW', where, `took ${(ms / 1000).toFixed(1)} s for something that should be quick`);
    }
    return result;
  }

  save(): void {
    const lines: string[] = [`# Click-through findings: journey ${this.journey}`, ''];
    lines.push('## Findings', '');
    if (this.findings.length === 0) lines.push('- None.');
    for (const finding of this.findings) {
      const shot = finding.shot === undefined ? '' : ` | ${finding.shot}`;
      lines.push(`- [${finding.kind}] ${finding.where} | ${finding.what}${shot}`);
    }
    lines.push('', '## Passed', '');
    if (this.passes.length === 0) lines.push('- None.');
    for (const pass of this.passes) lines.push(`- ${pass}`);
    lines.push('', '## Browser console errors', '');
    if (this.consoleErrors.length === 0) lines.push('- None.');
    for (const error of this.consoleErrors) lines.push(`- ${error}`);
    lines.push('', '## Page errors', '');
    if (this.pageErrors.length === 0) lines.push('- None.');
    for (const error of this.pageErrors) lines.push(`- ${error}`);
    lines.push('', '## Network responses >= 400 (expected ones are listed as such)', '');
    if (this.badRequests.length === 0) lines.push('- None.');
    for (const request of this.badRequests) lines.push(`- ${request}`);
    if (this.notes.length > 0) {
      lines.push('', '## Notes', '');
      for (const note of this.notes) lines.push(`- ${note}`);
    }
    writeFileSync(resolve(LOG_DIR, `findings-${this.journey}.md`), `${lines.join('\n')}\n`);
  }
}

export function watchBrowser(browser: Browser): void {
  browser.on('disconnected', () => undefined);
}

/** Listen for console errors, page errors and failed requests; expected() excuses intentional ones. */
export function watchPage(
  page: Page,
  run: Run,
  expected: (status: number, url: string) => boolean = () => false,
): void {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/favicon|ERR_ABORTED|failed to fetch dynamically imported/i.test(text)) return;
    run.consoleError(`${page.url()} :: ${text.slice(0, 300)}`);
  });
  page.on('pageerror', (error) => {
    run.pageError(`${page.url()} :: ${error.message.slice(0, 300)}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    if (expected(status, url)) return;
    run.badRequest(`HTTP ${status} ${url.replace(BASE, '')}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'failed';
    if (/ERR_ABORTED|cancelled/i.test(failure)) return;
    run.badRequest(`NETWORK FAIL ${request.url().replace(BASE, '')} :: ${failure}`);
  });
}

export function launch(): Promise<Browser> {
  return chromium.launch({ channel: 'chrome', headless: true });
}

export interface Seeded {
  token: string;
  userId: string;
  name: string;
  email: string;
}

/** Create a Google-style user and live session straight in the database; the token is never printed. */
export function seed(name: string, email: string): Seeded {
  const output = execFileSync(
    'bash',
    [
      '-c',
      'set -a; . ./.env; set +a; npx tsx scripts/clickthrough/seed-session.ts "$SEED_NAME" "$SEED_EMAIL"',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SEED_NAME: name, SEED_EMAIL: email },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const line = output.trim().split('\n').filter((entry) => entry.startsWith('{')).at(-1);
  if (line === undefined) throw new Error('seed-session printed no JSON');
  const parsed = JSON.parse(line) as { token?: unknown; userId?: unknown };
  if (typeof parsed.token !== 'string' || typeof parsed.userId !== 'string') {
    throw new Error('seed-session returned no token');
  }
  return { token: parsed.token, userId: parsed.userId, name, email };
}

export interface Person {
  context: BrowserContext;
  page: Page;
  seeded: Seeded;
}

export async function signedInPerson(
  browser: Browser,
  run: Run,
  options: {
    name: string;
    email: string;
    viewport?: { width: number; height: number };
    expected?: (status: number, url: string) => boolean;
  },
): Promise<Person> {
  const seeded = seed(options.name, options.email);
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
  });
  await context.addCookies([
    { name: 'kaki_session', value: seeded.token, domain: 'localhost', path: '/' },
  ]);
  const page = await context.newPage();
  watchPage(page, run, options.expected);
  return { context, page, seeded };
}

export async function guestPerson(
  browser: Browser,
  run: Run,
  options: {
    viewport?: { width: number; height: number };
    expected?: (status: number, url: string) => boolean;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  watchPage(page, run, options.expected);
  return { context, page };
}

/** The workspaces API's answer for the signed-in person. */
export async function workspaces(page: Page): Promise<Array<{ id: string; name: string; kind: string }>> {
  return page.evaluate(async () => {
    const response = await fetch('/api/workspaces');
    return (await response.json()) as Array<{ id: string; name: string; kind: string }>;
  });
}

export function stamp(): string {
  return String(Date.now()).slice(-7);
}

/** Meetings this process created, so finishing a journey can end them and free the open-meeting caps. */
const createdMeetings: Array<{ page: Page; meetingId: string }> = [];

/**
 * End every meeting this journey opened that is still running, then close the browser.
 * The click-through meetings count toward the server's open-meeting caps, so a suite that leaves
 * them running eventually makes the next journey fail with "busy". Cleanup runs after the journey's
 * own checks and screenshots, so it never changes what the journey measured.
 */
export async function closeBrowser(browser: Browser): Promise<void> {
  for (const opened of createdMeetings.splice(0)) {
    if (opened.page.isClosed()) continue;
    try {
      const info = (await opened.page.request
        .get(`${BASE}/api/meetings/${encodeURIComponent(opened.meetingId)}/info`)
        .then((response) => response.json())
        .catch(() => null)) as { status?: unknown } | null;
      if (info?.status === 'ended') continue;
      // The owner's screen feed carries END_MEETING even when the page has moved on to the minutes.
      // No named helper functions here: tsx's name-keeping helper does not exist inside the page.
      await opened.page.evaluate(async (meetingId) => {
        await new Promise<void>((resolve) => {
          const socket = new WebSocket(
            `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?audience=screen&meeting=${encodeURIComponent(meetingId)}`,
          );
          socket.addEventListener('open', () => {
            socket.send(JSON.stringify({ type: 'END_MEETING' }));
            window.setTimeout(() => {
              socket.close();
              resolve();
            }, 1_000);
          });
          socket.addEventListener('error', () => {
            socket.close();
            resolve();
          });
          window.setTimeout(() => {
            socket.close();
            resolve();
          }, 5_000);
        });
      }, opened.meetingId);
    } catch {
      // Cleanup must never turn a passing journey into a failure; a leftover room expires on its own.
    }
  }
  await browser.close();
}

/** Create a meeting on /new and return its link; leaves the page on the created-meeting card. */
export async function createMeeting(
  page: Page,
  title: string,
  options: { scheduleAt?: { date: string; time: string }; workspaceId?: string } = {},
): Promise<string> {
  await page.goto(`${BASE}/new`);
  const picker = page.locator('#new-meeting-workspace');
  await picker.waitFor({ state: 'visible', timeout: 20_000 });
  if (options.workspaceId !== undefined) {
    await picker.selectOption(options.workspaceId);
  } else {
    const current = await picker.inputValue();
    if (current === 'sample-nanyang-kopi') {
      const personal = (await picker.locator('option').evaluateAll((nodes) =>
        nodes.map((node) => ({ value: (node as HTMLOptionElement).value, label: node.textContent ?? '' })),
      )).find((option) => !/sample/i.test(option.label) && !option.value.startsWith('__'));
      if (personal !== undefined) await picker.selectOption(personal.value);
    }
  }
  await page.locator('#new-meeting-title').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('#new-meeting-title').fill(title);
  if (options.scheduleAt !== undefined) {
    await page.locator('input[type="date"]').fill(options.scheduleAt.date);
    await page.locator('input[type="time"]').fill(options.scheduleAt.time);
    await page.getByRole('button', { name: 'Schedule for later' }).click();
  } else {
    await page.getByRole('button', { name: 'Start now' }).click();
  }
  await page.getByText('The meeting is ready').waitFor({ timeout: 20_000 });
  const link = await page.locator('.product-invite-link a').first().getAttribute('href');
  if (link === null) throw new Error('created meeting has no link');
  const url = new URL(link, BASE);
  const [, route, rawMeetingId] = url.pathname.split('/');
  if (route !== 'm' || rawMeetingId === undefined || rawMeetingId === '') {
    throw new Error(`created meeting link ${url.toString()} has no meeting id`);
  }
  createdMeetings.push({ page, meetingId: decodeURIComponent(rawMeetingId) });
  return url.toString();
}

/** Start a real meeting room once the owner's waiting overlay shows; harmless when already running. */
export async function startIfWaiting(page: Page): Promise<boolean> {
  const start = page.getByRole('button', { name: 'Start the meeting' });
  try {
    await start.waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    return false;
  }
  await start.click();
  const overlay = page.getByRole('region', { name: 'Waiting for the meeting to start' });
  await Promise.race([
    overlay.waitFor({ state: 'hidden', timeout: 60_000 }),
    page.getByRole('alert').first().waitFor({ timeout: 60_000 }),
  ]).catch(() => undefined);
  return !(await overlay.isVisible().catch(() => false));
}

/** Open a created meeting as its owner and start it. */
export async function enterOwnRoom(page: Page, link: string): Promise<void> {
  await page.goto(link);
  const join = page.getByRole('button', { name: 'Join meeting' });
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button')).some(
          (button) => button.textContent?.trim() === 'Join meeting' || button.textContent?.trim() === 'Leave',
        ),
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  if (await join.isVisible().catch(() => false)) await join.click();
  await page.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 }).catch(() => undefined);
  await waitForRoomBar(page);
  await startIfWaiting(page);
}

/** The real room's bar: its Leave button is the stable marker that the room is connected. */
export async function waitForRoomBar(page: Page): Promise<void> {
  try {
    await page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ timeout: 60_000 });
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '');
    throw new Error(
      `room bar never appeared at ${page.url()}; page said: ${body.replace(/\s+/g, ' ').slice(0, 280)}`,
    );
  }
}

/** Open the invite popover and return its link. */
export async function inviteLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite people' });
  await dialog.waitFor({ timeout: 10_000 });
  const href = await dialog.getByRole('link').first().getAttribute('href');
  if (href === null) throw new Error('invite dialog has no link');
  return new URL(href, BASE).toString();
}

let fakeSpeaker: ReturnType<typeof createFakeSpeaker> | undefined;

/** The name this page joined with, remembered by the app for a reload. */
async function joinedName(page: Page): Promise<string> {
  const name = await page.evaluate(() => {
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key === null || (!key.startsWith('kaki.join.') && !key.startsWith('kaki.real.'))) continue;
      try {
        const value = JSON.parse(sessionStorage.getItem(key) ?? '{}') as { name?: unknown };
        if (typeof value.name === 'string' && value.name.trim() !== '') return value.name.trim();
      } catch {
        // A malformed stored join is not this helper's problem; keep looking.
      }
    }
    return undefined;
  });
  if (name === undefined) throw new Error('fake speech: this page has no remembered join name');
  return name;
}

/**
 * Make a person speak through the dev-only fake recogniser (`KAKI_FAKE_STT=1`). There is no text
 * box in either mode any more, so a scripted visitor says its line as its own LiveKit identity.
 */
export async function speakLine(page: Page, line: string): Promise<void> {
  fakeSpeaker ??= createFakeSpeaker();
  await fakeSpeaker.say(await joinedName(page), line);
}

export async function joinAsGuest(page: Page, link: string, name: string): Promise<void> {
  await page.goto(link);
  await page.getByText('You are invited').waitFor({ timeout: 15_000 });
  const nameBox = page.getByLabel('Your name');
  if (await nameBox.isVisible().catch(() => false)) await nameBox.fill(name);
  await page.getByRole('button', { name: 'Join meeting' }).click();
  await page.waitForURL(/\/m\/[^/]+\/room/, { timeout: 20_000 });
  await waitForRoomBar(page);
}

export function tomorrow(): string {
  const when = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return when.toISOString().slice(0, 10);
}
