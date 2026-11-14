/// <reference lib="dom" />
/** One visible, one-visitor rehearsal. The operator starts the draft-only stack separately. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium, devices, type Browser, type Page } from 'playwright';
import type { KakiEvent, Scenario, Task } from '@kaki/shared';

const BASE = 'http://localhost:5173';
const LOG_DIR = '.live-logs';
type Check = { at: string; name: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: string; shot?: string };
export type Line = { at: string; agendaIndex: number; speaker: string; text: string; sourceTime: string };
type UiLine = { at: string; source: string; text: string; topicTitle?: string };

export type PlaytestOptions = { role?: string; maxMinutes: number; phone: boolean };
export type AnswerContext = { scenario: Scenario; role: string; topicTitle: string; transcript: Line[]; intent: string };
export type FinishContext = { scenario?: Scenario; transcript: Line[]; playedTopics: number[] };
export type PlaytestHooks = {
  answer(context: AnswerContext): Promise<string>;
  finish(context: FinishContext): Promise<{ reportLines: string[]; summaryLines: string[] }>;
  reportLines(): string[];
};

function options(): PlaytestOptions {
  let role: string | undefined;
  let phone = false;
  let maxMinutes = 25;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--role' && process.argv[i + 1]) role = process.argv[++i];
    else if (arg === '--max-minutes' && process.argv[i + 1]) maxMinutes = Number(process.argv[++i]);
    else if (arg === '--phone') phone = true;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive');
  return { role, maxMinutes, phone };
}

function decisionFor(title: string): string {
  const name = title.toLowerCase();
  if (name.includes('counter staff')) return 'I would ask Auntie Mary in on double pay only if she agrees, and have a manager cover the counter if she says no. We keep the free-kopi crowd moving by pushing drinks to the kiosk.';
  if (name.includes('regulars')) return 'I would hold the kopi price and explain it at the counter, reply to the Facebook post, and have Arjun add a regulars price button only once we agree who counts as a regular.';
  if (name.includes('laptop')) return 'I would put a laptop zone on the 10 window-bar stools, add breakfast-table signs and set the booth socket timer, without asking staff to confront anyone.';
  if (name.includes('food safety')) return 'I would open at 8 without Set A until the 10 o clock delivery, give the officer both logs, and answer the customer before her review tonight.';
  if (name.includes('delivery')) return 'I would keep the office orders, price the $50 Office Platter and the 10%-off direct pickup code, and check the app change against the time Arjun has.';
  throw new Error(`No scenario decision prepared for: ${title}`);
}

const topicMarkers: Array<{ matches: RegExp; markers: RegExp }> = [
  { matches: /counter staff/i, markers: /short.staffed|rest day|double pay|till login/i },
  { matches: /regulars/i, markers: /regulars|price button|facebook post|loyalty/i },
  { matches: /laptop/i, markers: /laptop|window.bar|socket timer|wifi/i },
  { matches: /food safety/i, markers: /fridge|disposal log|inspection|eggs/i },
  { matches: /delivery/i, markers: /grabfood|office platter|pickup code|commission/i },
];

function escapeCell(value: string): string { return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
function stamp(): string { return new Date().toISOString(); }
function lineKey(line: Line): string { return `${line.sourceTime}|${line.speaker}|${line.text}`; }

export async function runLivePlaytest(parsed: PlaytestOptions, hooks?: PlaytestHooks): Promise<{ reportPath: string; passed: boolean; summaryLines: string[] }> {
  const startedAt = new Date();
  const stem = `playtest-${startedAt.toISOString().replace(/[:.]/g, '-')}`;
  const reportPath = join(LOG_DIR, `${stem}.md`);
  const shotDir = join(LOG_DIR, 'playtest-shots');
  const checks: Check[] = [];
  const transcript: Line[] = [];
  const uiLines: UiLine[] = [];
  const tasks = new Map<string, Task>();
  const taskHistory: string[] = [];
  let uiTaskCards: string[] = [];
  const errors: string[] = [];
  const notes: string[] = [];
  const seenLines = new Set<string>();
  const settled = new Set<string>();
  const offerHandled = new Set<number>();
  const accepted = new Set<string>();
  const reacted = new Set<string>();
  const playedTopics = new Set<number>();
  let extraReportLines: string[] = [];
  let summaryLines: string[] = [];
  let scenario: Scenario | undefined;
  let page: Page | undefined;
  let browser: Browser | undefined;
  let phoneMode = false;
  let agendaIndex = 0;
  let lastAiLineAt = Date.now();
  let lastProgressAt = Date.now();
  let closing = false;
  let screenSocketSeen = false;
  let pausedByApi = false;
  let shotNumber = 0;
  let globalDeadline = Date.now() + 25 * 60_000;
  let visitorRole = '';
  let lastNavigationAt = 0;
  const localUrl = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//;
  const strictModeSocketClose = /closed before the connection is established/i;
  const nearNavigation = (): boolean => lastNavigationAt > 0 && Date.now() - lastNavigationAt <= 5_000;

  /** Phone mode: the page must never scroll sideways; always keeps a screenshot so a person can eyeball the layout. */
  async function checkPhoneLayout(when: string): Promise<void> {
    if (!phoneMode || page === undefined || page.isClosed()) return;
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    await check(`Phone layout ${when}`, scrollWidth <= innerWidth, `page width ${scrollWidth}px in a ${innerWidth}px screen`);
    await mkdir(shotDir, { recursive: true });
    const shot = join(shotDir, `${stem}-phone-${when.replace(/\W+/g, '-')}.png`);
    await page.screenshot({ path: shot, timeout: 4_000 }).then(() => { const last = checks.at(-1); if (last !== undefined) last.shot ??= shot; })
      .catch((error: unknown) => notes.push(`Phone screenshot failed (${when}): ${String(error)}`));
  }

  // severity 'warn': a miss is listed for human review but does not fail the run.
  async function check(name: string, ok: boolean, detail: string, severity: 'fail' | 'warn' = 'fail'): Promise<void> {
    const item: Check = { at: stamp(), name, status: ok ? 'PASS' : severity === 'warn' ? 'WARN' : 'FAIL', detail };
    if (item.status === 'FAIL' && page !== undefined && !page.isClosed()) {
      try {
        await mkdir(shotDir, { recursive: true });
        const shot = join(shotDir, `${stem}-${String(++shotNumber).padStart(2, '0')}.png`);
        await page.screenshot({ path: shot, timeout: 4_000 });
        item.shot = shot;
      } catch (error) {
        notes.push(`Screenshot failed for ${name}: ${String(error)}`);
      }
    }
    checks.push(item);
    console.log(`${item.status} ${name}: ${detail}`);
  }

  function ingest(event: KakiEvent): void {
    const now = Date.now();
    if (event.type === 'MEETING_RESET') {
      transcript.length = 0;
      seenLines.clear();
      tasks.clear();
      settled.clear();
      reacted.clear();
      agendaIndex = 0;
      lastProgressAt = now;
    } else if (event.type === 'MEETING_RECORD_UPDATED') {
      if (event.payload.agendaIndex !== agendaIndex) {
        agendaIndex = event.payload.agendaIndex;
        lastProgressAt = now;
        lastAiLineAt = now;
      }
      pausedByApi = event.payload.paused === true;
    } else if (event.type === 'TRANSCRIPT_CHUNK') {
      const { speaker, text, timestamp } = event.payload;
      const key = `${timestamp}|${speaker}|${text}`;
      if (seenLines.has(key)) return;
      seenLines.add(key);
      transcript.push({ at: stamp(), agendaIndex, speaker, text, sourceTime: timestamp });
      lastProgressAt = now;
      if (!/robot visitor/i.test(speaker)) lastAiLineAt = now;
    } else if (event.type === 'TASK_UPDATED') {
      const previous = tasks.get(event.payload.task.id);
      tasks.set(event.payload.task.id, event.payload.task);
      if (previous?.status !== event.payload.task.status) {
        taskHistory.push(`${stamp()} ${event.payload.task.id} ${event.payload.task.agendaItemTitle ?? '(no agenda item)'} ${event.payload.task.actionKind ?? '(no kind)'} ${event.payload.task.status} ${event.payload.task.title}`);
      }
      if (previous?.status !== event.payload.task.status) lastProgressAt = now;
    } else if (event.type === 'TOPIC_SETTLED') {
      settled.add(event.payload.title);
      lastProgressAt = now;
    } else if (event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING') {
      closing = true;
      lastProgressAt = now;
    } else if (event.type === 'COMMAND_REJECTED') {
      errors.push(`${stamp()} command rejected: ${event.payload.commandType}: ${event.payload.reason}`);
    }
  }

  async function waitFor(name: string, predicate: () => boolean | Promise<boolean>, milliseconds: number, reportTimeout = true): Promise<boolean> {
    const end = Math.min(Date.now() + milliseconds, globalDeadline);
    let problem = '';
    while (Date.now() < end) {
      try { if (await predicate()) return true; }
      catch (error) { problem = String(error); }
      if (Date.now() - lastAiLineAt > 120_000 && Date.now() - lastProgressAt > 120_000) {
        await check(`Topic ${agendaIndex + 1} stuck`, false, 'No AI line or progress for over 120 seconds');
        lastProgressAt = Date.now();
      }
      await delay(350);
    }
    if (reportTimeout) await check(name, false, `Timed out after ${milliseconds / 1000}s${problem ? `; last error: ${problem}` : ''}`);
    return false;
  }

  async function uiContains(selector: string, value: string): Promise<boolean> {
    if (page === undefined) return false;
    return (await page.locator(selector).first().textContent().catch(() => ''))?.includes(value) === true;
  }

  async function speak(text: string, intent = text): Promise<boolean> {
    if (page === undefined) return false;
    if (hooks !== undefined) {
      if (scenario === undefined) throw new Error('Cannot choose an AI visitor line without a scenario');
      text = await hooks.answer({ scenario, role: visitorRole, topicTitle: scenario.agenda[agendaIndex]?.title ?? '(unknown topic)', transcript: [...transcript], intent });
    }
    const input = page.getByRole('textbox', { name: 'Type to the meeting' });
    try {
      await input.fill(text, { timeout: 5_000 });
      await input.press('Enter', { timeout: 5_000 });
      // A person on a phone closes the keyboard after sending; the app hides the Kaki panel while the box has focus.
      if (phoneMode) await input.blur();
      notes.push(`${stamp()} Robot Visitor typed: ${text}`);
      return true;
    } catch (error) {
      await check('Type bar', false, String(error));
      return false;
    }
  }

  async function handleOffer(index: number): Promise<void> {
    if (offerHandled.has(index)) return;
    const offer = transcript.find((line) => line.agendaIndex === index && /shall (?:we|i) lock in what you/i.test(line.text));
    if (offer === undefined) return;
    offerHandled.add(index);
    const before = transcript.length;
    await check(`Topic ${index + 1} lock offer`, true, offer.text);
    await speak('Before we lock that in, who will own the practical check tomorrow morning?', 'Ask who owns the practical check before locking the decision.');
    const recovered = await waitFor(`Topic ${index + 1} offer recovery`, () =>
      settled.has(scenario?.agenda[index]?.title ?? '') ||
      transcript.slice(before).some((line) => line.agendaIndex === index && /shall (?:we|i) lock in what you/i.test(line.text)), 35_000, false);
    let lockWorked = false;
    if (!recovered && page !== undefined) {
      const lock = page.getByRole('button', { name: 'Lock in my decision' });
      if (await lock.isEnabled().catch(() => false)) {
        await lock.click({ timeout: 5_000 });
        lockWorked = await waitFor(`Topic ${index + 1} lock fallback settlement`, () =>
          settled.has(scenario?.agenda[index]?.title ?? ''), 15_000, false);
      }
    }
    await check(`Topic ${index + 1} offer recovery`, recovered || lockWorked,
      recovered ? 'Offer returned or topic locked after clarification' : lockWorked ? 'Lock button settled topic after clarification' : 'Neither renewed offer nor working Lock after clarification');
  }

  async function acceptVisitorTasks(index: number): Promise<void> {
    if (page === undefined || scenario === undefined) return;
    const title = scenario.agenda[index]?.title;
    if (title === undefined) return;
    for (const task of tasks.values()) {
      if (task.agendaItemTitle !== title || task.assignee !== visitorRole || task.status !== 'DISPATCHED' || accepted.has(task.id)) continue;
      const button = page.locator('.kd-role-active').getByRole('button', { name: 'Accept · Let Kaki do it' }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5_000 });
        accepted.add(task.id);
        notes.push(`${stamp()} Accepted visitor task ${task.id} for draft review; no publish action was pressed.`);
      }
    }
  }

  function latestAiLine(index: number): Line | undefined {
    const lines = transcript.filter((line) => line.agendaIndex === index && !/robot visitor/i.test(line.speaker));
    return lines[lines.length - 1];
  }

  function firstColleagueLine(index: number, host: string): Line | undefined {
    return transcript.find((line) =>
      line.agendaIndex === index && !/robot visitor/i.test(line.speaker) && line.speaker !== host);
  }

  function lastRobotLineIndex(index: number): number {
    for (let line = transcript.length - 1; line >= 0; line -= 1) {
      const candidate = transcript[line]!;
      if (candidate.agendaIndex === index && /robot visitor/i.test(candidate.speaker)) return line;
    }
    return -1;
  }

  function robotLineCount(index: number): number {
    return transcript.filter((line) => line.agendaIndex === index && /robot visitor/i.test(line.speaker)).length;
  }

  function aiSpeaking(): Promise<boolean> {
    if (page === undefined) return Promise.resolve(false);
    return page.locator('.kd-state').filter({ hasText: 'speaking' }).count().then((count) => count > 0).catch(() => false);
  }

  function quietBeforeTyping(index: number): Promise<boolean> {
    return waitFor(`Topic ${index + 1} AI quiet`, async () =>
      Date.now() - lastAiLineAt >= 3_000 && !await aiSpeaking(), 30_000, false);
  }

  async function roomWaitsOnVisitor(index: number): Promise<boolean> {
    if (page === undefined) return false;
    // After the robot has spoken, only a colleague line that came after it can hand the floor back.
    const latest = latestAiLine(index);
    const robotAt = lastRobotLineIndex(index);
    if (robotAt >= 0 && (latest === undefined || transcript.indexOf(latest) < robotAt)) return false;
    if (await page.getByRole('region', { name: 'Your turn and starter questions' }).isVisible().catch(() => false)) return true;
    if (latest === undefined) return false;
    return /\brecap\b/i.test(latest.text) ||
      (/\?\s*$/.test(latest.text.trim()) && /robot visitor/i.test(latest.text));
  }

  /** Wait until the room hands the floor to the visitor. Gives up only after 60 s with no AI line, or if the topic moves. */
  async function waitForVisitorTurn(index: number): Promise<boolean> {
    while (agendaIndex === index && !closing && Date.now() < globalDeadline) {
      if (await roomWaitsOnVisitor(index) && Date.now() - lastAiLineAt >= 3_000 && !await aiSpeaking()) return true;
      if (Date.now() - lastAiLineAt > 60_000) {
        await check(`Topic ${index + 1} visitor turn`, false, 'No turn signal and no AI line for 60 s; answering anyway');
        return true;
      }
      await delay(350);
    }
    return false;
  }

  function isActionRequest(text: string): boolean {
    return /(?:can|could|would|will)\s+you\b[^?]*\b(?:post|email|send|schedule|confirm|draft|share|set\s+up|put\s+(?:that|this)\s+in)\b/i.test(text) ||
      /^(?:please\s+)?(?:post|email|send|schedule|confirm)\b/i.test(text);
  }

  function reasonFor(title: string): string {
    const name = title.toLowerCase();
    if (name.includes('counter staff')) return 'it covers the counter without spending more than the rush is worth.';
    if (name.includes('regulars')) return 'it keeps the old regulars while the new menu pays its way.';
    if (name.includes('laptop')) return 'it frees breakfast seats without putting staff in a confrontation.';
    if (name.includes('food safety')) return 'it keeps us straight with the officer and the customer.';
    if (name.includes('delivery')) return 'it protects margin while keeping the office orders.';
    throw new Error(`No scenario reason prepared for: ${title}`);
  }

  async function reactToRoom(index: number, title: string, decision: string | undefined, from: number): Promise<void> {
    if (page === undefined) return;
    const latest = latestAiLine(index);
    // Only react to AI lines spoken after the robot's own latest line: lines from before it have already been answered.
    const afterRobot = Math.max(from, lastRobotLineIndex(index) + 1);
    const fresh = transcript.slice(afterRobot).filter((line) =>
      line.agendaIndex === index && !/robot visitor/i.test(line.speaker) && !reacted.has(lineKey(line)));
    for (const line of fresh) {
      let reply: string | undefined;
      if (/\brecap\b/i.test(line.text)) reply = `No need, here's my call: ${decision ?? "let's table it and settle it in the follow-up."}`;
      else if (isActionRequest(line.text)) reply = 'Yes, please draft that for me.';
      else if (latest !== undefined && lineKey(latest) === lineKey(line) &&
        /\?\s*$/.test(line.text.trim()) && /robot visitor/i.test(line.text)) {
        reply = decision === undefined ? "Let's settle that in the follow-up." : `My call stands: ${reasonFor(title)}`;
      }
      if (reply === undefined) { reacted.add(lineKey(line)); continue; }
      if (robotLineCount(index) >= 4) { reacted.add(lineKey(line)); return; }
      if (!await quietBeforeTyping(index)) return;
      if (await speak(reply, `Reply to this latest colleague line and move the discussion forward: ${line.text}`)) reacted.add(lineKey(line));
      return;
    }
  }

  try {
    globalDeadline = Date.now() + parsed.maxMinutes * 60_000;
    await mkdir(LOG_DIR, { recursive: true });
    browser = await chromium.launch({ channel: 'chrome', headless: false, args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ] });
    phoneMode = parsed.phone;
    const context = await browser.newContext({ ...(phoneMode ? devices['Pixel 7'] : {}), permissions: ['microphone', 'camera'] });
    page = await context.newPage();
    page.setDefaultTimeout(5_000);
    page.on('framenavigated', (frame) => { if (frame === page!.mainFrame()) lastNavigationAt = Date.now(); });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (strictModeSocketClose.test(text) && nearNavigation()) {
        notes.push(`${stamp()} NOTE console: ${text} (React StrictMode dev double-mount after navigation)`);
        return;
      }
      const url = message.location().url;
      errors.push(`${stamp()} console: ${text}${url === '' ? '' : ` (${url})`}`);
    });
    page.on('pageerror', (error) => errors.push(`${stamp()} page: ${error.message}`));
    page.on('requestfailed', (request) => {
      if (localUrl.test(request.url())) {
        errors.push(`${stamp()} request failed: ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() < 400 || !localUrl.test(response.url())) return;
      errors.push(`${stamp()} response: HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
    });
    page.on('websocket', (socket) => {
      if (/^wss?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(socket.url())) {
        socket.on('socketerror', (error) => {
          const text = String(error);
          if (strictModeSocketClose.test(text) && nearNavigation()) {
            notes.push(`${stamp()} NOTE WebSocket ${socket.url()}: ${text} (React StrictMode dev double-mount after navigation)`);
            return;
          }
          errors.push(`${stamp()} WebSocket ${socket.url()}: ${text}`);
        });
      }
      if (!socket.url().includes('/ws?role=screen')) return;
      screenSocketSeen = true;
      socket.on('framereceived', (frame) => {
        try {
          const raw = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
          ingest(JSON.parse(raw) as KakiEvent);
        } catch (error) { errors.push(`${stamp()} /ws frame parse: ${String(error)}`); }
      });
    });
    // Passed as a string: tsx/esbuild renames the nested functions and injects a `__name` helper that does not exist
    // in the page, which used to surface as an app error.
    await page.addInitScript(`
      (() => {
        const state = window;
        state.__playtestLines = [];
        const seen = new Set();
        const capture = () => {
          for (const node of Array.from(document.querySelectorAll('.kd-caption, .kd-transcript-drawer li[data-kind="said"] span'))) {
            const text = node.textContent ? node.textContent.trim() : '';
            if (!text || seen.has(node.className + '|' + text)) continue;
            seen.add(node.className + '|' + text);
            const heading = document.querySelector('.sc-now h2');
            state.__playtestLines.push({
              at: new Date().toISOString(),
              source: node.closest('.kd-caption') ? 'caption' : 'transcript UI',
              text,
              topicTitle: heading ? heading.textContent.trim() : undefined,
            });
          }
        };
        new MutationObserver(capture).observe(document, { childList: true, subtree: true, characterData: true });
      })();
    `);
    lastNavigationAt = Date.now();
    await page.goto(`${BASE}/demo?mode=live`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    const response = await page.request.get(`${BASE}/api/scenario`, { timeout: 10_000 });
    if (!response.ok()) throw new Error(`/api/scenario returned HTTP ${response.status()}`);
    scenario = await response.json() as Scenario;
    const playable = scenario.roles.filter((role) => role.facilitator !== true &&
      scenario?.attendees.some((attendee) => attendee.role === role.id &&
        scenario?.npcs?.some((npc) => npc.attendee === attendee.name && npc.playable === true && npc.attendee !== 'Sam')));
    const role = playable.find((candidate) => candidate.id === parsed.role) ?? (parsed.role === undefined ? playable[0] : undefined);
    if (role === undefined) throw new Error(`Role ${parsed.role ?? '(default)'} is not a playable non-Sam seat; choices: ${playable.map((r) => r.id).join(', ')}`);
    visitorRole = role.id;
    await page.getByRole('textbox', { name: 'Your name' }).fill('Robot Visitor');
    await page.getByRole('radio', { name: new RegExp(role.label, 'i') }).click();
    const microphone = page.getByRole('button', { name: 'Microphone', exact: true });
    if (await microphone.getAttribute('aria-pressed') === 'true') await microphone.click();
    await check('Microphone muted', await microphone.getAttribute('aria-pressed') === 'false', 'Visitor input uses the type bar only');
    // A previous visitor who did not leave cleanly holds the only seat until LiveKit drops them; wait for it to free.
    const seatDeadline = Date.now() + 90_000;
    for (;;) {
      await page.getByRole('button', { name: 'Join to type' }).click();
      const joined = page.locator('.kd-meeting').first().waitFor({ timeout: 10_000 }).then(() => 'joined' as const);
      const full = page.getByText(/The meeting is full/).first().waitFor({ timeout: 10_000 }).then(() => 'full' as const);
      const outcome = await Promise.any([joined, full]).catch(() => 'unknown' as const);
      if (outcome !== 'full') break;
      if (Date.now() > seatDeadline) throw new Error('The visitor seat was still taken after 90 s: a previous visitor never left the room');
      notes.push(`${stamp()} Seat taken by a previous visitor; retrying join in 5 s`);
      await page.waitForTimeout(5_000);
    }
    if (await waitFor('Join meeting', () => page!.locator('.kd-meeting').count().then((n) => n > 0), 25_000)) {
      await check('Join role', true, `${role.id} as Robot Visitor, microphone muted`);
      await checkPhoneLayout('after join');
    }
    const activeResponse = await page.request.get(`${BASE}/api/scenario`, { timeout: 10_000 });
    if (!activeResponse.ok()) throw new Error(`Post-join /api/scenario returned HTTP ${activeResponse.status()}`);
    scenario = await activeResponse.json() as Scenario;
    await check('Two agenda topics for the session', scenario.agenda.length === 2,
      `API returned ${scenario.agenda.length}; each meeting draws two of the five topics`);
    await check('Event API connection', await waitFor('Screen event stream', async () =>
      screenSocketSeen && await page!.locator('.kd-meeting-panel').count() > 0 &&
      await page!.locator('.kd-meeting-panel .connection-banner').count() === 0, 10_000),
    '/ws?role=screen connected in the meeting panel');
    const start = page.getByRole('button', { name: 'Start the meeting' }).first();
    if (await waitFor('Start button', () => start.isVisible(), 20_000)) {
      await start.click();
      await check('Start acknowledged', await waitFor('Start acknowledgement', () =>
        page!.locator('.kd-meeting[data-needs-start="false"]').count().then((n) => n > 0), 20_000),
      'Start prompt closed after room acknowledgement');
    }

    const count = Math.min(4, scenario.agenda.length);
    const hostName = scenario.npcs?.find((npc) => npc.role === 'host')?.attendee ?? 'Sam';
    for (let i = 0; i < count && Date.now() < globalDeadline && !closing; i += 1) {
      const title = scenario.agenda[i]!.title;
      if (!await waitFor(`Topic ${i + 1} active`, () => agendaIndex === i, 120_000)) {
        if (agendaIndex !== i) continue;
      }
      playedTopics.add(i);
      notes.push(`${stamp()} Topic ${i + 1}: ${title}`);
      const decision = decisionFor(title);
      if (i === 0) {
        const pause = page.locator('.kd-typebar .kd-stop');
        await waitFor('First colleague line on topic 1', () => firstColleagueLine(0, hostName) !== undefined, 120_000);
        if (await waitFor('Pause control', () => pause.isVisible(), 15_000)) {
          // The type bar can shift by a pixel while captions grow; don't wait for it to be perfectly still.
          await pause.click({ force: true });
          const paused = await waitFor('Paused state', () => pausedByApi && uiContains('.kd-stop', 'Play'), 12_000);
          await check('Pause', paused, 'API record paused and UI showed Play');
          await page.locator('.kd-typebar .kd-stop').click({ force: true });
          const resumed = await waitFor('Resumed state', () => !pausedByApi && uiContains('.kd-stop', 'Pause'), 12_000);
          await check('Resume', resumed, 'API record resumed and UI showed Pause');
        }
      }

      const before = transcript.length;
      if (i === 1) {
        if (!await waitForVisitorTurn(i)) continue;
        notes.push(`${stamp()} Topic ${i + 1}: the Table topic chip needs a visitor line on this topic, so typed a short non-decision line first.`);
        await speak('Before I call it, what is the practical catch for the team?', 'Ask a practical question before making a decision.');
        await waitFor(`Topic ${i + 1} typed line in transcript`, () =>
          transcript.slice(before).some((line) => line.agendaIndex === i && /robot visitor/i.test(line.speaker)), 15_000);
        // The starter button only appears when the room is idle, and colleagues may keep talking for 50+ s after the
        // visitor's question, so wait for the visitor's turn again before looking for it.
        if (!await waitForVisitorTurn(i)) continue;
        const ideas = page.getByRole('button', { name: /Need an idea\?/ });
        const available = await waitFor(`Topic ${i + 1} table starter available`, () => ideas.isVisible(), 45_000);
        if (available) {
          await ideas.click();
          const chip = page.getByRole('button', { name: /Table topic & set a follow-up/ });
          const visible = await waitFor(`Topic ${i + 1} table topic chip`, () => chip.isVisible(), 8_000);
          if (visible) {
            if (await quietBeforeTyping(i)) {
              for (const line of transcript) {
                if (line.agendaIndex === i && !/robot visitor/i.test(line.speaker)) reacted.add(lineKey(line));
              }
              await chip.click();
            }
            await check('Table topic starter', await waitFor('Table starter transcript', () =>
              transcript.some((line) => line.agendaIndex === i && /table it for now and set up a follow-up/i.test(line.text)), 15_000),
            'Starter chip sent its line to the meeting');
          }
        }
      } else {
        if (!await waitForVisitorTurn(i)) continue;
        const latest = latestAiLine(i);
        const recap = latest !== undefined && /\brecap\b/i.test(latest.text) && !reacted.has(lineKey(latest));
        if (recap) reacted.add(lineKey(latest));
        if (!await speak(recap ? `No need, here's my call: ${decision}` : decision, 'Make your opening-day call on this topic, responding to the latest exchange.')) continue;
        if (i === 3) {
          const lock = page.getByRole('button', { name: 'Lock in my decision' });
          const thinking = await waitFor('Thinking with Lock enabled', async () =>
            await page!.locator('.kd-state').filter({ hasText: 'thinking' }).count() > 0 && await lock.isEnabled(), 12_000);
          if (thinking) {
            await check('Lock enabled while thinking', true, 'AI tile showed thinking and Lock was enabled');
            await lock.click();
          }
        }
      }

      await waitFor(`Topic ${i + 1} typed line in transcript`, () =>
        transcript.slice(before).some((line) => line.agendaIndex === i && /robot visitor/i.test(line.speaker)), 15_000);

      const settleEnd = Math.min(Date.now() + 90_000, globalDeadline);
      while (!settled.has(title) && agendaIndex === i && Date.now() < settleEnd) {
        if (robotLineCount(i) < 4) await handleOffer(i);
        await acceptVisitorTasks(i);
        await reactToRoom(i, title, i === 1 ? undefined : decision, before);
        await delay(350);
      }
      if (!settled.has(title) && agendaIndex === i) {
        const lock = page.getByRole('button', { name: 'Lock in my decision' });
        if (await lock.isEnabled().catch(() => false)) {
          await lock.click();
          notes.push(`${stamp()} Lock fallback pressed for ${title}`);
        }
      }
      await check(`Topic ${i + 1} settled`, await waitFor(`Topic ${i + 1} settlement event`, () => settled.has(title), 20_000), title);
      await checkPhoneLayout(`topic ${i + 1} settled`);
      if (settled.has(title)) {
        await check(`Topic ${i + 1} follow-up card`, await waitFor(`Topic ${i + 1} task card`, () =>
          [...tasks.values()].some((task) => task.agendaItemTitle === title), 20_000),
        `TASK_UPDATED with agendaItemTitle=${title}`);
      }

      if (i === 1 && i + 1 < count) {
        const isSpeaking = () => page!.locator('.kd-state').filter({ hasText: 'speaking' }).count().then((n) => n > 0);
        let speaking = await waitFor('AI speaking before Skip', isSpeaking, 15_000, false);
        if (!speaking) {
          await speak('Before we leave this, could someone give one quick recap of the next step?', 'Ask for a quick recap of the next step.');
          speaking = await waitFor('AI reply before Skip', isSpeaking, 20_000);
        }
        if (speaking) {
          const priorLines = transcript.length;
          await page.getByRole('button', { name: /Skip to next topic/ }).click();
          await check('Skip during AI reply', await waitFor('Skip advanced agenda', () => agendaIndex > i, 20_000),
            `Skip clicked while AI tile was speaking; transcript had ${priorLines} lines`);
        }
      } else {
        const end = Math.min(Date.now() + 125_000, globalDeadline);
        while (agendaIndex === i && !closing && Date.now() < end) {
          if (!settled.has(title)) {
            if (robotLineCount(i) < 4) await handleOffer(i);
            await reactToRoom(i, title, i === 1 ? undefined : decision, before);
          }
          await acceptVisitorTasks(i);
          if (Date.now() - lastAiLineAt > 120_000 && Date.now() - lastProgressAt > 120_000) {
            await check(`Topic ${i + 1} stuck`, false, 'No AI line or progress for over 120 seconds');
            lastProgressAt = Date.now();
          }
          await delay(500);
        }
        const advanced = agendaIndex > i || (i === count - 1 && closing);
        await check(`Topic ${i + 1} advanced`, advanced, advanced ? 'Agenda moved or meeting concluded' : 'No advancement within 125 seconds');
        if (!advanced && i + 1 < count) {
          const skip = page.getByRole('button', { name: /Skip to next topic/ });
          if (await skip.isVisible().catch(() => false)) {
            await skip.click();
            notes.push(`${stamp()} Recovery: clicked Skip after advancement timeout`);
            await waitFor('Recovery agenda move', () => agendaIndex > i, 15_000);
          }
        }
      }
    }

    if (!closing) await waitFor('Meeting wrap-up', () => closing, 75_000);
    await check('Meeting reached wrap-up', closing, closing ? 'HOST_SPEECH_TRIGGERED CLOSING received' : 'No closing event');
    await checkPhoneLayout('at wrap-up');
    const storedUiLines = await page.evaluate('window.__playtestLines ?? []') as UiLine[];
    uiLines.push(...storedUiLines);
    uiTaskCards = await page.locator('.kd-task-card, .kd-role-active .card-title').allTextContents();
    const control = [...transcript.map((line) => ({ at: line.at, text: line.text, source: 'API transcript' })), ...uiLines]
      .filter((line) => /KAKI_CONTROL|\{\s*"state"\s*:|\{\s*"(?:kind|followUp|wingmanNeeded)"\s*:|^\s*\{\s*"[^"\n]+"\s*:|```(?:json)?/i.test(line.text));
    await check('No control text leaked', control.length === 0, control.length ? control.map((line) => `${line.at} ${line.source}: ${line.text}`).join(' / ') : 'No control or JSON text in captions/transcript');
    const duplicates = new Map<string, string[]>();
    for (const task of tasks.values()) {
      if (task.status === 'DISMISSED' || task.status === 'SUPERSEDED' || task.agendaItemTitle === undefined) continue;
      // Same rule as the server: one card per agenda item, deliverable and owner (a colleague may own their own).
      const key = `${task.agendaItemTitle}|${task.actionKind ?? 'none'}|${task.assignee ?? task.suggestedAssignee}`;
      duplicates.set(key, [...(duplicates.get(key) ?? []), task.id]);
    }
    const repeated = [...duplicates].filter(([, ids]) => ids.length > 1);
    await check('No duplicate follow-up cards', repeated.length === 0,
      repeated.length ? repeated.map(([key, ids]) => `${key}: ${ids.join(', ')}`).join(' / ') : 'At most one active card per agenda item, kind and owner');
    const stale = transcript.filter((line) => {
      if (line.agendaIndex <= 0 || /robot visitor/i.test(line.speaker)) return false;
      const current = scenario?.agenda[line.agendaIndex]?.title ?? '';
      const currentPattern = topicMarkers.find((item) => item.matches.test(current))?.markers;
      if (currentPattern?.test(line.text)) return false;
      return scenario?.agenda.slice(0, line.agendaIndex).some((old) =>
        topicMarkers.find((item) => item.matches.test(old.title))?.markers.test(line.text)) === true;
    });
    await check('No prior-topic speech after move', stale.length === 0,
      stale.length ? `Review each: shared resources may carry over legitimately. ${stale.map((line) => `item ${line.agendaIndex + 1} ${line.speaker}: ${line.text}`).join(' / ')}` : 'No prior-topic marker in later AI transcript lines', 'warn');
    const staleCaptions = uiLines.filter((line) => {
      if (line.source !== 'caption') return false;
      const index = scenario?.agenda.findIndex((item) => item.title === line.topicTitle) ?? -1;
      if (index <= 0) return false;
      const currentPattern = topicMarkers.find((item) => item.matches.test(line.topicTitle ?? ''))?.markers;
      if (currentPattern?.test(line.text)) return false;
      return scenario?.agenda.slice(0, index).some((old) =>
        topicMarkers.find((item) => item.matches.test(old.title))?.markers.test(line.text)) === true;
    });
    await check('No prior-topic captions after move', staleCaptions.length === 0,
      staleCaptions.length ? `Review each: shared resources may carry over legitimately. ${staleCaptions.map((line) => `${line.topicTitle}: ${line.text}`).join(' / ')}` : 'No prior-topic marker in later captions', 'warn');
    await check('Browser console and localhost requests', errors.length === 0, errors.length ? `${errors.length} error(s)` : 'No console errors, page errors, rejected commands, socket errors, or failed localhost requests');
    if (offerHandled.size === 0) checks.push({ at: stamp(), name: 'Lock offer after clarification', status: 'PASS', detail: 'Conditional check: no time/turn-budget offer appeared during this run' });
    else await check('Lock offer after clarification', checks.some((item) => item.name.includes('offer recovery') && item.status === 'FAIL') === false,
      `Handled offers on topic(s) ${[...offerHandled].map((i) => i + 1).join(', ')}`);
  } catch (error) {
    await check('Playtest setup or flow', false, error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    if (page !== undefined && !page.isClosed() && uiLines.length === 0) {
      const storedUiLines = await page.evaluate('window.__playtestLines ?? []').catch(() => []) as UiLine[];
      uiLines.push(...storedUiLines);
    }
    // Leave the room cleanly (the page disconnects on pagehide) so the next run's visitor gets the seat.
    if (page !== undefined && !page.isClosed()) {
      const closed = page.waitForEvent('close', { timeout: 5_000 }).catch(() => notes.push(`${stamp()} Page did not close cleanly; LiveKit may hold the seat briefly`));
      await page.close({ runBeforeUnload: true }).catch(() => undefined);
      await closed;
    }
    if (browser !== undefined) await browser.close().catch((error: unknown) => notes.push(`Could not close launched browser: ${String(error)}`));
    if (hooks !== undefined) {
      try {
        const finished = await hooks.finish({ scenario, transcript: [...transcript], playedTopics: [...playedTopics] });
        extraReportLines = finished.reportLines;
        summaryLines = finished.summaryLines;
      } catch (error) {
        await check('AI judge', false, error instanceof Error ? error.message : String(error));
      }
      extraReportLines.push(...hooks.reportLines());
    }
    const lines = [
      `# Kopitiam live playtest — ${startedAt.toISOString()}`,
      '',
      `Role: ${visitorRole || '(not joined)'} · Name: Robot Visitor · Device: ${phoneMode ? 'Pixel 7 emulation' : 'desktop'} · Duration: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`,
      `Result: **${checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS'}**${checks.some((item) => item.status === 'WARN') ? ` · ${checks.filter((item) => item.status === 'WARN').length} warning(s) to review` : ''}`,
      '',
      '| Time (UTC) | Check | Result | Detail | Screenshot |',
      '| --- | --- | --- | --- | --- |',
      ...checks.map((item) => `| ${item.at} | ${escapeCell(item.name)} | ${item.status} | ${escapeCell(item.detail)} | ${item.shot ?? ''} |`),
      '',
      '## Full API transcript',
      '',
      ...(transcript.length ? transcript.map((line) => `- ${line.at} (source ${line.sourceTime}, item ${line.agendaIndex + 1}) **${line.speaker}:** ${line.text}`) : ['(none)']),
      '',
      '## UI captions and transcript lines seen',
      '',
      ...(uiLines.length ? uiLines.map((line) => `- ${line.at} [${line.source}, ${line.topicTitle ?? 'no topic'}] ${line.text}`) : ['(none)']),
      '',
      '## Task cards seen (latest API state)',
      '',
      ...(tasks.size ? [...tasks.values()].map((task) => `- ${task.id} · ${task.agendaItemTitle ?? '(no agenda item)'} · ${task.actionKind ?? '(no kind)'} · ${task.status} · ${task.title} · owner ${task.assignee ?? task.suggestedAssignee}`) : ['(none)']),
      '',
      '### Task updates and visible cards',
      '',
      ...(taskHistory.length ? taskHistory.map((item) => `- ${item}`) : ['(no task updates)']),
      ...uiTaskCards.map((item) => `- UI: ${item.trim()}`),
      '',
      '## Errors',
      '',
      ...(errors.length ? errors.map((item) => `- ${item}`) : ['(none)']),
      '',
      '## Actions and notes',
      '',
      ...(notes.length ? notes.map((item) => `- ${item}`) : ['(none)']),
      '',
      ...extraReportLines,
    ];
    await mkdir(LOG_DIR, { recursive: true });
    await writeFile(reportPath, lines.join('\n'));
    console.log(`Report: ${reportPath}`);
    for (const line of summaryLines) console.log(line);
  }
  return { reportPath, passed: checks.every((item) => item.status !== 'FAIL'), summaryLines };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runLivePlaytest(options()).then((result) => { process.exitCode = result.passed ? 0 : 1; });
}
