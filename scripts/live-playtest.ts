/// <reference lib="dom" />
/**
 * One visible, one-visitor rehearsal. The operator starts the draft-only stack separately.
 * `--act` needs a stack started without KAKI_DRAFT_ONLY, and writes to the local mock tools only.
 */
import '../server/src/env.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium, devices, type Browser, type Page } from 'playwright';
import { joinSeatRoles, type KakiEvent, type Scenario, type Task } from '@kaki/shared';
import {
  duplicatedAiLines, judgeCardFollowsFinalCall, rejoinResumes, rejoinWelcome, silencePromptWithin, type Behaviour,
} from './playtest-behaviours';
import {
  draftOnlyRefusal, isRobotSpeakerName, judgeArtifactReachability, judgeCardCompletion, nextRobotTaskAction,
  wingmanFactVerdicts,
} from './playtest-actions';
import {
  decideRoomReply, roomReplyModelFromEnv, type RoomReplyModel, type RoomReplyOutcome,
} from './room-reply';
import { decideRobotCall } from './robot-decision';
import { reportResultLine, statusFor, type PlaytestCheck } from './playtest-report';
import { escapeCell, parseArgv, stamp, writeMarkdownReport } from './lib/playtest';

/** The demo to test; set KAKI_PLAYTEST_URL (e.g. the cloud URL) to test a deployed copy instead of the local stack. */
const BASE = (process.env.KAKI_PLAYTEST_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const BASE_ORIGIN = new URL(BASE).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LOG_DIR = '.live-logs';
type Check = PlaytestCheck;
export type Line = {
  at: string; agendaIndex: number; speaker: string; text: string; sourceTime: string;
  /** A server-marked host gate, so a lock-in offer does not need phrase matching. */
  gate?: 'lock-offer';
};
type UiLine = { at: string; source: string; text: string; topicTitle?: string };

type PlaytestOptions = { role?: string; maxMinutes: number; phone: boolean; shots?: boolean; act?: boolean };
export type AnswerContext = { scenario: Scenario; role: string; topicTitle: string; transcript: Line[]; intent: string };
export type FinishContext = { scenario?: Scenario; transcript: Line[]; playedTopics: number[] };
export type PlaytestHooks = {
  answer(context: AnswerContext): Promise<string>;
  finish(context: FinishContext): Promise<{ reportLines: string[]; summaryLines: string[] }>;
  reportLines(): string[];
  /** Optional live-meeting behaviour the robot runs; a plain scripted run leaves this unset. */
  behaviour?: Behaviour;
};

function options(): PlaytestOptions {
  const args = parseArgv(process.argv, {
    booleans: ['--phone', '--shots', '--act'],
    values: ['--role', '--max-minutes'],
  });
  const role = args.value('--role');
  if (role === '') throw new Error('Unknown or incomplete argument: --role');
  const maxMinutesRaw = args.value('--max-minutes');
  if (maxMinutesRaw === '') throw new Error('Unknown or incomplete argument: --max-minutes');
  const maxMinutes = maxMinutesRaw === undefined ? 25 : Number(maxMinutesRaw);
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error('--max-minutes must be positive');
  return { role, maxMinutes, phone: args.has('--phone'), shots: args.has('--shots'), act: args.has('--act') };
}

const topicMarkers: Array<{ matches: RegExp; markers: RegExp }> = [
  { matches: /counter staff/i, markers: /short.staffed|rest day|double pay|till login/i },
  { matches: /regulars/i, markers: /regulars|price button|facebook post|loyalty/i },
  { matches: /laptop/i, markers: /laptop|window.bar|socket timer|wifi/i },
  { matches: /food safety/i, markers: /fridge|disposal log|inspection|eggs/i },
  { matches: /delivery/i, markers: /grabfood|office platter|pickup code|commission/i },
];

function lineKey(line: Line): string { return `${line.sourceTime}|${line.speaker}|${line.text}`; }

/**
 * The transcript speaker for this run's own seat. The server writes a person's line under the
 * setup's seat display name, not the name typed at join, so reading the transcript must follow it.
 */
const robotSpeaker = 'Robot Visitor';
function isRobotSpeaker(speaker: string): boolean {
  return isRobotSpeakerName(speaker, robotSpeaker);
}

export async function runLivePlaytest(parsed: PlaytestOptions, hooks: PlaytestHooks | undefined, roomReply: RoomReplyModel): Promise<{ reportPath: string; passed: boolean; summaryLines: string[] }> {
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
  const shots: Array<{ at: string; path: string }> = [];
  const shotTaken = new Set<string>();
  const seenLines = new Set<string>();
  const settled = new Set<string>();
  const offerHandled = new Set<number>();
  const accepted = new Set<string>();
  const claimed = new Set<string>();
  const approved = new Set<string>();
  const actedTitles = new Map<string, { title: string; approvedAt: number }>();
  const factTopics = new Set<number>();
  const reacted = new Set<string>();
  const playedTopics = new Set<number>();
  let extraReportLines: string[] = [];
  let summaryLines: string[] = [];
  let roomReplyFallbacks = 0;
  let guestCallFallbacks = 0;
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
  let visitorRoleLabel = '';
  let hostName = 'Sam';
  let lastNavigationAt = 0;
  const silentChecked = new Set<number>();
  const interruptArmed = new Set<number>();
  const interruptedTopics = new Set<number>();
  const flipFlopFirst = new Map<number, string>();
  const flipFlopFinal = new Map<number, string>();
  let lastVisitorLine = '';
  let rejoined = false;
  const localUrl = new RegExp(`^https?://(?:localhost|127\\.0\\.0\\.1|${BASE_ORIGIN})(?::\\d+)?/`);
  const strictModeSocketClose = /closed before the connection is established/i;
  const nearNavigation = (): boolean => lastNavigationAt > 0 && Date.now() - lastNavigationAt <= 5_000;

  /** One screenshot for a named moment, in phone mode or when --shots is on. Each moment is captured at most once. */
  async function keepShot(when: string): Promise<string | undefined> {
    if (!phoneMode && parsed.shots !== true) return undefined;
    if (page === undefined || page.isClosed()) return undefined;
    const slug = when.replace(/\W+/g, '-');
    if (shotTaken.has(slug)) return undefined;
    shotTaken.add(slug);
    await mkdir(shotDir, { recursive: true });
    const shot = join(shotDir, `${stem}-${phoneMode ? 'phone' : 'desktop'}-${slug}.png`);
    try {
      await page.screenshot({ path: shot, timeout: 4_000 });
      shots.push({ at: stamp(), path: shot });
      return shot;
    } catch (error) {
      notes.push(`Screenshot failed (${when}): ${String(error)}`);
      return undefined;
    }
  }

  /** Phone mode: the page must never scroll sideways; always keeps a screenshot so a person can eyeball the layout. */
  async function checkPhoneLayout(when: string): Promise<void> {
    if (!phoneMode || page === undefined || page.isClosed()) return;
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
    await check(`Phone layout ${when}`, scrollWidth <= innerWidth, `page width ${scrollWidth}px in a ${innerWidth}px screen`);
    const shot = await keepShot(when);
    const last = checks.at(-1);
    if (shot !== undefined && last !== undefined) last.shot ??= shot;
  }

  // severity 'warn': a miss is listed for human review but does not fail the run.
  async function check(name: string, ok: boolean, detail: string, severity: 'fail' | 'warn' = 'fail'): Promise<void> {
    const item: Check = { at: stamp(), name, status: statusFor(ok, severity), detail };
    if (item.status === 'FAIL' && page !== undefined && !page.isClosed()) {
      try {
        await mkdir(shotDir, { recursive: true });
        const shot = join(shotDir, `${stem}-${String(++shotNumber).padStart(2, '0')}.png`);
        await page.screenshot({ path: shot, timeout: 4_000 });
        item.shot = shot;
        shots.push({ at: item.at, path: shot });
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
      factTopics.clear();
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
      // Read the gate defensively: a deployed server may not send it, and an older shared build may not type it.
      const gate = (event.payload as { gate?: unknown }).gate === 'lock-offer' ? 'lock-offer' as const : undefined;
      const key = `${timestamp}|${speaker}|${text}`;
      if (seenLines.has(key)) return;
      seenLines.add(key);
      transcript.push({ at: stamp(), agendaIndex, speaker, text, sourceTime: timestamp, ...(gate === undefined ? {} : { gate }) });
      lastProgressAt = now;
      if (!isRobotSpeaker(speaker)) lastAiLineAt = now;
    } else if (event.type === 'TASK_UPDATED') {
      const previous = tasks.get(event.payload.task.id);
      tasks.set(event.payload.task.id, event.payload.task);
      if (previous?.status !== event.payload.task.status) {
        taskHistory.push(`${stamp()} ${event.payload.task.id} ${event.payload.task.agendaItemTitle ?? '(no agenda item)'} ${event.payload.task.actionKind ?? '(no kind)'} ${event.payload.task.status} ${event.payload.task.title}`);
      }
      if (previous?.status !== event.payload.task.status) lastProgressAt = now;
    } else if (event.type === 'FACT_FOUND') {
      if (event.audience.kind === 'role' && event.audience.role === visitorRole) {
        factTopics.add(event.payload.agendaIndex);
      }
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

  async function typeLine(text: string): Promise<{ ok: boolean; at: number }> {
    if (page === undefined) return { ok: false, at: Date.now() };
    const input = page.getByRole('textbox', { name: 'Type to the meeting' });
    try {
      await input.fill(text, { timeout: 5_000 });
      await input.press('Enter', { timeout: 5_000 });
      const at = Date.now();
      // A person on a phone closes the keyboard after sending; the app hides the Kaki panel while the box has focus.
      if (phoneMode) await input.blur();
      notes.push(`${stamp()} Robot Visitor typed: ${text}`);
      return { ok: true, at };
    } catch (error) {
      await check('Type bar', false, String(error));
      return { ok: false, at: Date.now() };
    }
  }

  async function ensureMicrophoneMuted(): Promise<boolean> {
    if (page === undefined) return false;
    const microphone = page.getByRole('button', { name: 'Microphone', exact: true });
    if (await microphone.getAttribute('aria-pressed').catch(() => null) === 'true') {
      await microphone.click({ timeout: 5_000 }).catch(() => undefined);
    }
    return await microphone.getAttribute('aria-pressed').catch(() => null) === 'false';
  }

  /** Reuse the start-of-run join flow: name, seat, muted microphone, then wait out a seat still held by the last visitor. */
  async function joinAsRobot(deadline: number): Promise<'joined' | 'full' | 'unknown'> {
    if (page === undefined || visitorRoleLabel === '') return 'unknown';
    await page.getByRole('textbox', { name: 'Your name' }).fill(robotSpeaker);
    await page.getByRole('radio', { name: new RegExp(visitorRoleLabel, 'i') }).click();
    for (;;) {
      if (Date.now() > deadline) return 'full';
      await page.getByRole('button', { name: 'Join to type' }).click();
      const joined = page.locator('.kd-meeting').first().waitFor({ timeout: 10_000 }).then(() => 'joined' as const);
      const full = page.getByText(/The meeting is full/).first().waitFor({ timeout: 10_000 }).then(() => 'full' as const);
      const outcome = await Promise.any([joined, full]).catch(() => 'unknown' as const);
      if (outcome === 'joined') return 'joined';
      if (outcome !== 'full') return 'unknown';
      if (Date.now() + 5_000 > deadline) return 'full';
      notes.push(`${stamp()} Seat taken by a previous visitor; retrying join in 5 s`);
      await delay(5_000);
    }
  }

  async function silentGate(index: number): Promise<void> {
    if (silentChecked.has(index)) return;
    silentChecked.add(index);
    // The room went quiet at its last AI line, and a prompt for this topic must come after the robot's own last line.
    const quietAt = lastAiLineAt;
    const from = Math.max(0, lastRobotLineIndex(index) + 1);
    const limit = 60_000;
    const end = Math.min(quietAt + limit, globalDeadline);
    let prompt: { prompted: boolean; waitedMs: number; text?: string } = { prompted: false, waitedMs: limit };
    while (Date.now() < end && agendaIndex === index && !closing) {
      prompt = silencePromptWithin(transcript, from, 'Robot Visitor', quietAt, limit, hostName);
      if (prompt.prompted) break;
      await delay(350);
    }
    if (!prompt.prompted) prompt = { prompted: false, waitedMs: Math.min(limit, Date.now() - quietAt) };
    await check(`Topic ${index + 1} silence prompt`, prompt.prompted,
      prompt.prompted
        ? `${hostName} prompted the visitor after ${(prompt.waitedMs / 1000).toFixed(1)}s: ${prompt.text ?? ''}`
        : `No AI line addressing the visitor within ${(prompt.waitedMs / 1000).toFixed(0)}s`);
  }

  /** The interrupter does not wait for quiet; it waits for a colleague to speak, then types over them. */
  async function waitForOpeningTurn(index: number): Promise<boolean> {
    if (hooks?.behaviour === 'interrupter' && !interruptedTopics.has(index)) {
      const speaking = await waitFor(`Topic ${index + 1} AI speaking to interrupt`, () => aiSpeaking(), 60_000, false);
      if (speaking) {
        interruptArmed.add(index);
        return true;
      }
      notes.push(`${stamp()} Topic ${index + 1}: no AI colleague speaking to interrupt; waiting for the visitor's turn instead`);
    }
    return waitForVisitorTurn(index);
  }

  async function evaluateInterrupt(index: number, typedAt: number, robotLineBefore: number, wasSpeaking: boolean): Promise<void> {
    // Measure the speaking state from the moment the line was typed, while the transcript catches up in parallel.
    const endedAt = (async (): Promise<number | undefined> => {
      const end = Math.min(Date.now() + 4_000, globalDeadline);
      while (Date.now() < end) {
        if (!await aiSpeaking()) return Date.now();
        await delay(350);
      }
      return undefined;
    })();
    const landed = await waitFor(`Topic ${index + 1} typed line after interrupt`, () =>
      transcript.slice(robotLineBefore).some((line) => line.agendaIndex === index && isRobotSpeaker(line.speaker)), 15_000, false);
    const ended = await endedAt;
    const robotAt = lastRobotLineIndex(index);
    const nextLine = await waitFor(`Topic ${index + 1} AI line after interrupt`, () =>
      robotAt >= 0 && transcript.slice(robotAt + 1).some((line) => !isRobotSpeaker(line.speaker)), 20_000, false);
    const duplicates = robotAt < 0 ? [] : duplicatedAiLines(transcript.filter((line) => line.agendaIndex === index));
    const within = ended !== undefined && ended - typedAt <= 4_000;
    const ok = wasSpeaking && landed && within && nextLine && duplicates.length === 0;
    const detail = !wasSpeaking
      ? 'No AI colleague was speaking when the line was typed'
      : !landed
        ? 'The interrupted line never reached the transcript'
        : !within
          ? 'The speaking state did not end within 4 s of the typed line'
          : !nextLine
            ? 'No AI line followed the interrupted line in the transcript'
            : duplicates.length > 0
              ? `AI line repeated word for word afterwards: ${duplicates.join(' / ')}`
              : `Speaking ended ${(((ended ?? typedAt) - typedAt) / 1000).toFixed(1)}s after the typed line; the next AI line followed it`;
    await check(`Topic ${index + 1} interrupt yields`, ok, detail);
  }

  async function leaveAndRejoin(): Promise<void> {
    if (page === undefined) return;
    const agendaBefore = agendaIndex;
    const earlierTaskIds = [...tasks.keys()];
    const transcriptStart = transcript.length;
    const previousOpening = rejoinWelcome(transcript, 0, hostName)?.text;
    const leftAt = Date.now();
    let left = false;
    try {
      await page.locator('.kd-stage .lk-disconnect-button').first().click({ timeout: 5_000 });
      left = await waitFor('Rejoin leave control', () => page!.getByRole('textbox', { name: 'Your name' }).isVisible(), 10_000, false);
    } catch (error) {
      notes.push(`${stamp()} Leave control failed: ${String(error)}`);
    }
    if (!left) {
      await check('Rejoin resumes topic', false, 'The Leave control did not return to the join form');
      return;
    }
    if (!await ensureMicrophoneMuted()) notes.push(`${stamp()} Microphone could not be muted before the rejoin`);
    // Re-entering the meeting remounts its sockets; treat it like the initial navigation so a StrictMode double-mount is a note, not an error.
    lastNavigationAt = Date.now();
    const joined = await joinAsRobot(leftAt + 20_000) === 'joined';
    const joinedAt = Date.now();
    if (!joined) {
      await check('Rejoin resumes topic', false, `Could not rejoin within ${((joinedAt - leftAt) / 1000).toFixed(1)}s`);
      return;
    }
    // A fresh join shows the briefing again; step to Start and press it so the robot can type, then let the room settle.
    const next = page.getByRole('button', { name: 'Next: How to play →' }).first();
    if (await next.isVisible().catch(() => false)) await next.click({ timeout: 5_000 }).catch(() => undefined);
    const start = page.getByRole('button', { name: 'Start the meeting' }).first();
    if (await start.isVisible().catch(() => false)) {
      await start.click({ timeout: 5_000 }).catch((error: unknown) => notes.push(`${stamp()} Rejoin Start click failed: ${String(error)}`));
      await waitFor('Rejoin start acknowledgement', () =>
        page!.locator('.kd-meeting[data-needs-start="false"]').count().then((count) => count > 0), 20_000, false);
    }
    // A server-side reset clears the transcript, so fall back to its start when it has shrunk.
    const findWelcome = () => rejoinWelcome(transcript, transcript.length < transcriptStart ? 0 : transcriptStart, hostName, previousOpening);
    await waitFor('Rejoin welcome check', () => findWelcome() !== undefined, 6_000, false);
    const welcome = findWelcome();
    const verdict = rejoinResumes({
      agendaBefore,
      agendaAfter: agendaIndex,
      closingAfter: closing,
      hostWelcomeAfter: welcome !== undefined,
      earlierTaskIds,
      currentTaskIds: [...tasks.keys()],
      secondsToRejoin: (joinedAt - leftAt) / 1000,
    });
    await check('Rejoin resumes topic', verdict.ok,
      verdict.ok
        ? `Rejoined in ${((joinedAt - leftAt) / 1000).toFixed(1)}s; agenda topic ${agendaBefore + 1} → ${agendaIndex + 1}; ${earlierTaskIds.length} earlier card(s) remained; no new opening line`
        : verdict.reasons.join('; '));
  }

  async function speak(text: string, intent = text): Promise<boolean> {
    if (page === undefined) return false;
    if (hooks !== undefined) {
      if (scenario === undefined) throw new Error('Cannot choose an AI visitor line without a scenario');
      text = await hooks.answer({ scenario, role: visitorRole, topicTitle: scenario.agenda[agendaIndex]?.title ?? '(unknown topic)', transcript: [...transcript], intent });
    }
    const index = agendaIndex;
    if (hooks?.behaviour === 'silent') await silentGate(index);
    if (hooks?.behaviour === 'interrupter' && interruptArmed.delete(index)) {
      const robotLineBefore = transcript.length;
      const stillSpeaking = await waitFor(`Topic ${index + 1} AI still speaking`, () => aiSpeaking(), 15_000, false);
      const typed = await typeLine(text);
      if (!typed.ok) return false;
      lastVisitorLine = text;
      interruptedTopics.add(index);
      await evaluateInterrupt(index, typed.at, robotLineBefore, stillSpeaking);
      return true;
    }
    const typed = await typeLine(text);
    if (typed.ok) lastVisitorLine = text;
    return typed.ok;
  }

  const LOCK_OFFER_PHRASE = /shall (?:we|i) lock in what you/i;

  /** The structured server gate when present; the old phrase match only as a logged backstop. */
  function lockOfferLine(index: number, from = 0): { line: Line; via: 'signal' | 'phrase' } | undefined {
    const lines = transcript.slice(from).filter((line) => line.agendaIndex === index);
    const signaled = lines.find((line) => line.gate === 'lock-offer');
    if (signaled !== undefined) return { line: signaled, via: 'signal' };
    const phrased = lines.find((line) => LOCK_OFFER_PHRASE.test(line.text));
    return phrased === undefined ? undefined : { line: phrased, via: 'phrase' };
  }

  async function handleOffer(index: number): Promise<void> {
    if (offerHandled.has(index)) return;
    const offer = lockOfferLine(index);
    if (offer === undefined) return;
    offerHandled.add(index);
    const before = transcript.length;
    if (offer.via === 'phrase') {
      notes.push(`${stamp()} Topic ${index + 1}: lock offer detected by exact phrase; the server emitted no structured offer signal`);
    }
    await check(`Topic ${index + 1} lock offer`, true, `${offer.via === 'signal' ? 'Structured lock-offer signal' : 'Phrase backstop'}: ${offer.line.text}`);
    await speak('Before we lock that in, who will own the practical check tomorrow morning?', 'Ask who owns the practical check before locking the decision.');
    const recovered = await waitFor(`Topic ${index + 1} offer recovery`, () =>
      settled.has(scenario?.agenda[index]?.title ?? '') ||
      lockOfferLine(index, before) !== undefined, 35_000, false);
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
    // With --act each card is claimed and approved through actOnRobotTasks instead.
    if (parsed.act === true) return;
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

  /** True once the end-of-meeting minutes card is waiting for a person to approve it. */
  function minutesCardReady(): boolean {
    return [...tasks.values()].some(
      (task) => task.purpose === 'meeting_minutes' && task.status === 'DRAFT_READY',
    );
  }

  /** Click Approve & publish for a card whose draft is on screen, waiting for the draft to appear first. */
  async function approveRobotTask(task: { id: string; title: string }): Promise<void> {
    if (page === undefined) return;
    const button = page.locator('.kd-role-active').getByRole('button', { name: 'Approve & publish' }).first();
    try {
      await button.waitFor({ state: 'visible', timeout: 60_000 });
      await button.click({ timeout: 5_000 });
      approved.add(task.id);
      actedTitles.set(task.id, { title: task.title, approvedAt: Date.now() });
      notes.push(`${stamp()} Act: approved card ${task.id} (${task.title}) as ${visitorRole}`);
    } catch (error) {
      approved.add(task.id);
      await check(`Card ${task.title} approve control`, false, `No approve control within 60 s: ${String(error)}`);
    }
  }

  /** --act: handle every card assigned to the robot's role through the same controls a guest uses. */
  async function actOnRobotTasks(): Promise<void> {
    if (parsed.act !== true || page === undefined || page.isClosed() || visitorRole === '') return;
    for (;;) {
      const next = nextRobotTaskAction(tasks.values(), visitorRole, claimed, approved);
      if (next === undefined) return;
      if (next.step === 'claim') {
        const accept = page.locator('.kd-role-active').getByRole('button', { name: 'Accept · Let Kaki do it' }).first();
        try {
          await accept.waitFor({ state: 'visible', timeout: 10_000 });
          await accept.click({ timeout: 5_000 });
          claimed.add(next.task.id);
          notes.push(`${stamp()} Act: claimed card ${next.task.id} (${next.task.title}) as ${visitorRole}`);
        } catch (error) {
          claimed.add(next.task.id);
          await check(`Card ${next.task.title} accept control`, false, `No accept control within 10 s: ${String(error)}`);
          continue;
        }
      }
      await approveRobotTask(next.task);
    }
  }

  /** --act: wait out each approved card, verify its artifact, then check the facts the wingman surfaced. */
  async function finishActedCards(): Promise<void> {
    for (const [id, acted] of actedTitles) {
      const deadline = acted.approvedAt + 60_000;
      let task = tasks.get(id);
      const finished = (status: string | undefined): boolean => status === 'COMPLETED' || status === 'SYNCED';
      while (Date.now() < deadline && !finished(task?.status) && task?.status !== 'FAILED') {
        await delay(350);
        task = tasks.get(id);
      }
      const timedOut = !finished(task?.status) && task?.status !== 'FAILED';
      const verdict = judgeCardCompletion(task, timedOut);
      await check(`Card ${acted.title} completed`, verdict.ok, verdict.detail);
      if (verdict.ok && task?.artifactUrl !== undefined) {
        let status: number | undefined;
        let error: string | undefined;
        try {
          const response = await fetch(task.artifactUrl, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          status = response.status;
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
        const artifact = judgeArtifactReachability(task.artifactUrl, status, error);
        await check(`Artifact ${task.artifactUrl} reachable`, artifact.ok, artifact.detail);
      }
    }
    for (const verdict of wingmanFactVerdicts([...playedTopics], factTopics)) {
      const title = scenario?.agenda[verdict.topic]?.title;
      const topic = `topic ${verdict.topic + 1}${title === undefined ? '' : ` (${title})`}`;
      await check(`Wingman fact for topic ${verdict.topic + 1}`, verdict.ok,
        verdict.ok ? `FACT_FOUND for ${visitorRole} on ${topic}` : `No FACT_FOUND for ${visitorRole} on ${topic}`, 'warn');
    }
  }

  function latestAiLine(index: number): Line | undefined {
    const lines = transcript.filter((line) => line.agendaIndex === index && !isRobotSpeaker(line.speaker));
    return lines[lines.length - 1];
  }

  function firstColleagueLine(index: number, host: string): Line | undefined {
    return transcript.find((line) =>
      line.agendaIndex === index && !isRobotSpeaker(line.speaker) && line.speaker !== host);
  }

  function lastRobotLineIndex(index: number): number {
    for (let line = transcript.length - 1; line >= 0; line -= 1) {
      const candidate = transcript[line]!;
      if (candidate.agendaIndex === index && isRobotSpeaker(candidate.speaker)) return line;
    }
    return -1;
  }

  function robotLineCount(index: number): number {
    return transcript.filter((line) => line.agendaIndex === index && isRobotSpeaker(line.speaker)).length;
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

  function replyIntent(outcome: RoomReplyOutcome, asked: string): string {
    return `Answer this latest line: "${asked}". The point to make (${outcome.kind}): "${outcome.reply}". Say it in your own words, in one short line.`;
  }

  async function reactToRoom(index: number, title: string, decision: string | undefined, from: number): Promise<void> {
    if (page === undefined || scenario === undefined) return;
    // Only react to AI lines spoken after the robot's own latest line: lines from before it have already been answered.
    const afterRobot = Math.max(from, lastRobotLineIndex(index) + 1);
    const fresh = transcript.slice(afterRobot).filter((line) =>
      line.agendaIndex === index && !isRobotSpeaker(line.speaker) && !reacted.has(lineKey(line)));
    if (fresh.length === 0) return;
    const markFresh = (): void => { for (const line of fresh) reacted.add(lineKey(line)); };
    const request = {
      scenario,
      role: visitorRole,
      topicTitle: title,
      transcript: [...transcript],
      ...(decision === undefined ? {} : { decision }),
      fresh,
      hostName,
      robotLineCount: robotLineCount(index),
    };
    // The model judges whether and how the guest answers; an AI visitor then rewrites that line in its persona.
    const outcome: RoomReplyOutcome = await decideRoomReply(request, roomReply);
    if (outcome.warning !== undefined) {
      roomReplyFallbacks += 1;
      await check(`Topic ${index + 1} room reply model`, false, outcome.warning, 'warn');
    }
    // The model call takes time; the topic may have settled or moved on while it was thinking.
    if (settled.has(title) || agendaIndex !== index || closing) { markFresh(); return; }
    if (outcome.reply === null) { markFresh(); return; }
    const cap = outcome.kind === 'confirm' || outcome.kind === 'accept-offer' ? 6 : 4;
    if (robotLineCount(index) >= cap) { markFresh(); return; }
    if (!await quietBeforeTyping(index)) return;
    const last = fresh.at(-1)!;
    const previous = fresh.at(-2);
    const asked = previous !== undefined && previous.speaker === last.speaker ? `${previous.text} ${last.text}` : last.text;
    if (await speak(outcome.reply, replyIntent(outcome, asked))) {
      markFresh();
      notes.push(`${stamp()} Robot reply (${outcome.kind}): ${outcome.reply}`);
    }
  }

  try {
    globalDeadline = Date.now() + parsed.maxMinutes * 60_000;
    await mkdir(LOG_DIR, { recursive: true });
    browser = await chromium.launch({ channel: 'chrome', headless: false, args: [
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      // Keep full speed when the owner minimises or covers the window, so a run behaves the same unwatched.
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      // Silent by default so a run does not talk over whatever the owner is doing; KAKI_PLAYTEST_SOUND=1 to listen.
      ...(process.env.KAKI_PLAYTEST_SOUND === '1' ? [] : ['--mute-audio']),
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
      if (new RegExp(`^wss?://(?:localhost|127\\.0\\.0\\.1|${BASE_ORIGIN})(?::\\d+)?/`).test(socket.url())) {
        socket.on('socketerror', (error) => {
          const text = String(error);
          if (strictModeSocketClose.test(text) && nearNavigation()) {
            notes.push(`${stamp()} NOTE WebSocket ${socket.url()}: ${text} (React StrictMode dev double-mount after navigation)`);
            return;
          }
          errors.push(`${stamp()} WebSocket ${socket.url()}: ${text}`);
        });
      }
      // Read the shared screen and this visitor's own seat feed, the two channels the practice page
      // itself opens. Facts arrive on the seat feed (and, for a practice screen, only for that seat);
      // commands stay on the page, so the robot never needs an owner channel.
      const socketUrl = new URL(socket.url());
      const isScreen = socketUrl.searchParams.get('audience') === 'screen';
      const isSeat = visitorRole !== '' && socketUrl.searchParams.get('role') === visitorRole;
      if (!isScreen && !isSeat) return;
      if (isScreen) screenSocketSeen = true;
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
    const response = await page.request.get(`${BASE}/api/scenario?kind=practice`, { timeout: 10_000 });
    if (!response.ok()) throw new Error(`/api/scenario?kind=practice returned HTTP ${response.status()}`);
    scenario = await response.json() as Scenario;
    // The seats the join form offers (one shared function), minus the chair: the robot plays a guest, not Sam.
    const playable = joinSeatRoles(scenario).filter((role) => role.facilitator !== true);
    const role = playable.find((candidate) => candidate.id === parsed.role) ?? (parsed.role === undefined ? playable[0] : undefined);
    if (role === undefined) throw new Error(`Role ${parsed.role ?? '(default)'} is not a playable non-Sam seat; choices: ${playable.map((r) => r.id).join(', ')}`);
    visitorRole = role.id;
    visitorRoleLabel = role.label;
    await check('Microphone muted', await ensureMicrophoneMuted(), 'Visitor input uses the type bar only');
    // A previous visitor who did not leave cleanly holds the only seat until LiveKit drops them; wait for it to free.
    const seatDeadline = Date.now() + 90_000;
    if (await joinAsRobot(seatDeadline) === 'full') {
      throw new Error('The visitor seat was still taken after 90 s: a previous visitor never left the room');
    }
    if (await waitFor('Join meeting', () => page!.locator('.kd-meeting').count().then((n) => n > 0), 25_000)) {
      await check('Join role', true, `${role.id} as Robot Visitor, microphone muted`);
      await checkPhoneLayout('after join');
      await keepShot('after join');
    }
    const activeResponse = await page.request.get(`${BASE}/api/scenario?kind=practice`, { timeout: 10_000 });
    if (!activeResponse.ok()) throw new Error(`Post-join /api/scenario?kind=practice returned HTTP ${activeResponse.status()}`);
    scenario = await activeResponse.json() as Scenario;
    hostName = scenario.npcs?.find((npc) => npc.role === 'host')?.attendee ?? 'Sam';
    // The server records a person's lines under the name they joined with, never the seat's character name.
    await check('Robot speaker identity', true, `Transcript speaker is exactly "${robotSpeaker}", the name the robot joined with`);
    await check('Two agenda topics for the session', scenario.agenda.length === 2,
      `API returned ${scenario.agenda.length}; each meeting draws two of the five topics`);
    await check('Event API connection', await waitFor('Screen event stream', async () =>
      screenSocketSeen && await page!.locator('.kd-meeting-panel').count() > 0 &&
      await page!.locator('.kd-meeting-panel .connection-banner').count() === 0, 10_000),
    '/ws?audience=screen connected in the meeting panel');
    // Start sits on the briefing's second screen.
    const next = page.getByRole('button', { name: 'Next: How to play →' }).first();
    if (await waitFor('Briefing Next button', () => next.isVisible(), 20_000)) await next.click();
    const start = page.getByRole('button', { name: 'Start the meeting' }).first();
    if (await waitFor('Start button', () => start.isVisible(), 20_000)) {
      await start.click();
      await check('Start acknowledged', await waitFor('Start acknowledgement', () =>
        page!.locator('.kd-meeting[data-needs-start="false"]').count().then((n) => n > 0), 20_000),
      'Start prompt closed after room acknowledgement');
    }
    // The busy opening is Sam's welcome caption, a couple of seconds into the meeting rather than at the blank first frame.
    if (phoneMode || parsed.shots === true) {
      const welcome = await waitFor('Opening welcome caption', () =>
        transcript.some((line) => line.agendaIndex === 0 && line.speaker === hostName), 45_000, false);
      if (welcome) {
        await delay(2_000);
        await keepShot('opening');
      }
    }

    const count = Math.min(4, scenario.agenda.length);
    for (let i = 0; i < count && Date.now() < globalDeadline && !closing; i += 1) {
      const title = scenario.agenda[i]!.title;
      if (!await waitFor(`Topic ${i + 1} active`, () => agendaIndex === i, 120_000)) {
        if (agendaIndex !== i) continue;
      }
      playedTopics.add(i);
      notes.push(`${stamp()} Topic ${i + 1}: ${title}`);
      // The brief is alive while the first colleague line of the topic is in captions.
      if (phoneMode || parsed.shots === true) {
        await waitFor(`Topic ${i + 1} first colleague line`, () => firstColleagueLine(i, hostName) !== undefined, 120_000, false);
        await keepShot(`topic ${i + 1} brief`);
      }
      let decision: string | undefined;
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
        if (!await waitForOpeningTurn(i)) continue;
        notes.push(`${stamp()} Topic ${i + 1}: the Table topic chip needs a visitor line on this topic, so typed a short non-decision line first.`);
        await speak('Before I call it, what is the practical catch for the team?', 'Ask a practical question before making a decision.');
        await waitFor(`Topic ${i + 1} typed line in transcript`, () =>
          transcript.slice(before).some((line) => line.agendaIndex === i && isRobotSpeaker(line.speaker)), 15_000);
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
                if (line.agendaIndex === i && !isRobotSpeaker(line.speaker)) reacted.add(lineKey(line));
              }
              await chip.click();
            }
            await check('Table topic starter', await waitFor('Table starter transcript', () =>
              transcript.some((line) => line.agendaIndex === i && /table it for now and set up a follow-up/i.test(line.text)), 15_000),
            'Starter chip sent its line to the meeting');
          }
        }
      } else {
        if (!await waitForOpeningTurn(i)) continue;
        const decided = await decideRobotCall({
          scenario, role: visitorRole, topicTitle: title, transcript: [...transcript],
        }, roomReply);
        if (decided.warning !== undefined) {
          guestCallFallbacks += 1;
          await check(`Topic ${i + 1} guest call model`, false, decided.warning, 'warn');
        }
        decision = decided.call;
        const latest = latestAiLine(i);
        const recap = latest !== undefined && /\brecap\b/i.test(latest.text) && !reacted.has(lineKey(latest));
        if (recap) reacted.add(lineKey(latest));
        const flipFlop = i === 0 && hooks?.behaviour === 'flip-flop';
        const intent = flipFlop ? 'make a call' : 'Make your opening-day call on this topic, responding to the latest exchange.';
        if (!await speak(recap ? `No need, here's my call: ${decision}` : decision, intent)) continue;
        if (flipFlop) {
          flipFlopFirst.set(i, lastVisitorLine);
          const replied = await waitFor(`Topic ${i + 1} colleague reply after first call`, () => {
            const firstAt = lastRobotLineIndex(i);
            return firstAt >= 0 && transcript.slice(firstAt + 1).some((line) =>
              line.agendaIndex === i && !isRobotSpeaker(line.speaker));
          }, 60_000, false);
          if (replied && await quietBeforeTyping(i)) {
            if (await speak('', 'Actually, scrap that — reverse your last call completely and choose a clearly different option, starting the line with "Actually, scrap that —".')) {
              flipFlopFinal.set(i, lastVisitorLine);
            }
          } else {
            notes.push(`${stamp()} Topic ${i + 1}: no colleague reply after the first call, so the flip-flop reversal was skipped`);
          }
        }
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
        transcript.slice(before).some((line) => line.agendaIndex === i && isRobotSpeaker(line.speaker)), 15_000);

      const settleEnd = Math.min(Date.now() + 90_000, globalDeadline);
      while (!settled.has(title) && agendaIndex === i && Date.now() < settleEnd) {
        if (robotLineCount(i) < 4) await handleOffer(i);
        await acceptVisitorTasks(i);
        await actOnRobotTasks();
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
      await keepShot(`topic ${i + 1} settled`);
      if (settled.has(title)) {
        await check(`Topic ${i + 1} follow-up card`, await waitFor(`Topic ${i + 1} task card`, () =>
          [...tasks.values()].some((task) => task.agendaItemTitle === title), 20_000),
        `TASK_UPDATED with agendaItemTitle=${title}`);
        await keepShot(`topic ${i + 1} card`);
        await actOnRobotTasks();
      }

      if (i === 0 && hooks?.behaviour === 'flip-flop') {
        const first = flipFlopFirst.get(0);
        const final = flipFlopFinal.get(0);
        const card = [...tasks.values()]
          .filter((task) => task.agendaItemTitle === title)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        if (card === undefined) {
          await check('Topic 1 card follows final call', false, 'No follow-up card was created for topic 1');
        } else if (first === undefined || final === undefined) {
          await check('Topic 1 card follows final call', false, 'The flip-flop did not record both the first and the final call');
        } else {
          try {
            const verdict = await judgeCardFollowsFinalCall(card, first, final, roomReply);
            await check('Topic 1 card follows final call', verdict.follows,
              `${verdict.reason} Card: ${card.decisionSource ?? card.context ?? '(empty)'}`);
          } catch (error) {
            await check('Topic 1 card follows final call', false,
              `Card judge failed, so the card could not be verified: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      if (i === 0 && hooks?.behaviour === 'rejoin' && !rejoined) {
        rejoined = true;
        await acceptVisitorTasks(i);
        await actOnRobotTasks();
        await leaveAndRejoin();
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
          await page.getByRole('button', { name: 'Next agenda item' }).click();
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
          await actOnRobotTasks();
          if (Date.now() - lastAiLineAt > 120_000 && Date.now() - lastProgressAt > 120_000) {
            await check(`Topic ${i + 1} stuck`, false, 'No AI line or progress for over 120 seconds');
            lastProgressAt = Date.now();
          }
          await delay(500);
        }
        const advanced = agendaIndex > i || (i === count - 1 && closing);
        await check(`Topic ${i + 1} advanced`, advanced, advanced ? 'Agenda moved or meeting concluded' : 'No advancement within 125 seconds');
        if (!advanced && i + 1 < count) {
          const skip = page.getByRole('button', { name: 'Next agenda item' });
          if (await skip.isVisible().catch(() => false)) {
            await skip.click();
            notes.push(`${stamp()} Recovery: clicked Skip after advancement timeout`);
            await waitFor('Recovery agenda move', () => agendaIndex > i, 15_000);
          }
        }
      }
      // Read the new topic on screen, not the last caption of the one that just ended.
      if ((phoneMode || parsed.shots === true) && agendaIndex > i && i + 1 < count) {
        await delay(2_000);
        await keepShot(`topic ${i + 2} change`);
      }
    }

    if (!closing) await waitFor('Meeting wrap-up', () => closing, 75_000);
    await check('Meeting reached wrap-up', closing, closing ? 'HOST_SPEECH_TRIGGERED CLOSING received' : 'No closing event');
    await checkPhoneLayout('at wrap-up');
    await keepShot('at wrap-up');
    if (parsed.act === true) {
      // The minutes card is created a moment after the closing cue; approve it like any other guest card.
      const minutesReady = await waitFor('Minutes card for approval', minutesCardReady, 30_000, false);
      await check('Minutes card for approval', minutesReady,
        minutesReady ? 'Minutes card appeared in DRAFT_READY for approval' : 'No end-of-meeting minutes card appeared within 30 s');
      await actOnRobotTasks();
      await finishActedCards();
    }
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
      if (line.agendaIndex <= 0 || isRobotSpeaker(line.speaker)) return false;
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
    if (offerHandled.size === 0) {
      checks.push({
        at: stamp(), name: 'Lock offer after clarification', status: 'NOT EXERCISED',
        detail: 'No time/turn-budget lock offer appeared during this run, so the offer and recovery path was not tested',
      });
    } else {
      await check('Lock offer after clarification', checks.some((item) => item.name.includes('offer recovery') && item.status === 'FAIL') === false,
        `Handled offers on topic(s) ${[...offerHandled].map((i) => i + 1).join(', ')}`);
    }
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
    summaryLines.push(`Room reply fallbacks: ${roomReplyFallbacks}`);
    summaryLines.push(`Guest call fallbacks: ${guestCallFallbacks}`);
    const lines = [
      `# Kopitiam live playtest — ${startedAt.toISOString()}`,
      '',
      `Role: ${visitorRole || '(not joined)'} · Name: Robot Visitor · Device: ${phoneMode ? 'Pixel 7 emulation' : 'desktop'} · Duration: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s`,
      reportResultLine(checks),
      '',
      '| Time (UTC) | Check | Result | Detail | Screenshot |',
      '| --- | --- | --- | --- | --- |',
      ...checks.map((item) => `| ${item.at} | ${escapeCell(item.name)} | ${item.status} | ${escapeCell(item.detail)} | ${item.shot ?? ''} |`),
      '',
      '## Screenshots',
      '',
      ...(shots.length ? shots.map((shot) => `- ${shot.at} — ${shot.path}`) : ['(none)']),
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
    await writeMarkdownReport(reportPath, lines);
    console.log(`Report: ${reportPath}`);
    for (const line of summaryLines) console.log(line);
  }
  return { reportPath, passed: checks.every((item) => item.status !== 'FAIL'), summaryLines };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = options();
  if (parsed.act === true) {
    const refusal = draftOnlyRefusal(process.env);
    if (refusal !== undefined) {
      console.error(refusal);
      process.exit(2);
    }
  }
  void runLivePlaytest(parsed, undefined, roomReplyModelFromEnv()).then((result) => { process.exitCode = result.passed ? 0 : 1; });
}
