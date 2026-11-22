import {
  hostIdentityOf,
  humanRoles,
  roleLabel,
  speakerName,
  type Fact,
  type KakiEvent,
  type Role,
  type Scenario,
  type SearchCompanyData,
  type Task,
  type WingmanNotePayload,
} from '@kaki/shared';
import { Pool } from 'pg';
import { CommandError } from '../core/hub';
import type { KakiContext, KakiModule } from '../core/modules';
import { notetakerLlmFromEnv, type LlmClient } from '../services/llm';
import { SAMPLE_WORKSPACE_ID } from '../workspace/constants';
import { isoDay } from './knowledge/dates';
import { gatewayConfigFromEnv, missingGatewayEnv } from './knowledge/gateway';
import { indexMeetingRecord } from './knowledge/indexer';
import { createCompanySearchFromEnv } from './knowledge/search';
import {
  ASK_SCHEMA,
  ASKED_SCHEMA,
  RECORD_SCHEMA,
  askMessages,
  askedMessages,
  parseAskedReply,
  parseAskReply,
  groundedLine,
  parseRecordReply,
  recordMessages,
  type AnswerPart,
  type WingmanLine,
} from './prompts';

/** The plain-words answer when the meeting and the person's workspace both have nothing. */
const NOTHING_TEXT = 'Nothing on that in this meeting or your workspace.';
/** Shown in the person's panel, never swallowed, when the workspace search itself fails. */
const SEARCH_FAILED_TEXT = "Couldn't search your workspace just now.";
/** Shown when the meeting answer could not be read, so a model failure never looks like an empty meeting. */
const MEETING_FAILED_TEXT = "Couldn't read this meeting just now.";

/** How much of the transcript the assistant keeps and reads. */
const MAX_TRANSCRIPT_LINES = 200;
const MAX_ASK_LINES = 200;
const MAX_ASKED_LINES = 6;
const MAX_RECORD_LINES = 8;
const MAX_ASKED_FACTS = 2;
const MAX_RECORD_FACTS = 3;
/** One record note per person in this window; checks themselves are throttled to it too. */
const DEFAULT_RECORD_RATE_LIMIT_MS = 90_000;
/** A short pause so a burst of lines becomes one direct-question check. */
const DEFAULT_ASKED_CHECK_DELAY_MS = 1_000;

interface WingmanModuleOptions {
  /** The model the notetaker uses; tests inject a scripted client. */
  llm?: LlmClient;
  /** A prepared workspace search, used by tests and the check script. */
  search?: SearchCompanyData;
  env?: NodeJS.ProcessEnv;
  /** Clock used for the record rate limit; tests fix it. */
  now?: () => number;
  recordRateLimitMs?: number;
  askedCheckDelayMs?: number;
}

/** One person in a seat, with the name they are known by in this meeting. */
interface Person {
  role: Role;
  name: string;
}

interface NoteRecord {
  role: Role;
  retainKey: string;
  payload: WingmanNotePayload;
}

function missingSearchEnv(env: NodeJS.ProcessEnv): string[] {
  return [...missingGatewayEnv(env), ...(env.POSTGRES_URL ? [] : ['POSTGRES_URL'])];
}

/** The one searchable record of an ended meeting: its minutes and its to-dos. */
function meetingKnowledgeText(options: {
  title: string;
  date: string;
  agenda: ReadonlyArray<{ title: string }>;
  tasks: readonly Task[];
  minutes?: string;
}): string {
  const parts = [`[Meeting: ${options.title}, ${options.date}]`];
  if (options.minutes !== undefined && options.minutes.trim() !== '') {
    parts.push('', 'Minutes:', '', options.minutes.trim());
  } else {
    parts.push('', 'Agenda:', ...options.agenda.map((item) => `- ${item.title}`));
  }
  const todos = options.tasks.filter(
    (task) => task.purpose !== 'meeting_minutes' && task.status !== 'DISMISSED',
  );
  parts.push('', 'To-dos:');
  if (todos.length === 0) {
    parts.push('- None recorded.');
  } else {
    for (const task of todos) {
      const owner = task.assignee === undefined ? '' : ` (${task.assignee})`;
      parts.push(`- ${task.title}${owner} [${task.status}]`);
    }
  }
  return parts.join('\n');
}

/** The people currently in a seat, falling back to the scenario's human seats when no holders exist. */
function peopleInMeeting(ctx: KakiContext): Person[] {
  const scenario = ctx.activeScenario();
  const holders = ctx.meetingDetails?.().holders ?? [];
  const byRole = new Map<Role, Person>();
  for (const holder of holders) {
    const wanted = holder.seat.trim().toLowerCase();
    const role = scenario.roles.find((candidate) => candidate.id.trim().toLowerCase() === wanted);
    if (role === undefined) continue;
    byRole.set(role.id, {
      role: role.id,
      name: (holder.displayName?.trim() || holder.name).trim(),
    });
  }
  if (byRole.size > 0) return [...byRole.values()];
  return humanRoles(scenario).map((role) => {
    const attendee = scenario.attendees.find((candidate) => candidate.role === role.id);
    return {
      role: role.id,
      name: (attendee?.displayName?.trim() || attendee?.name || role.label).trim(),
    };
  });
}

function personFor(ctx: KakiContext, role: Role): Person {
  return (
    peopleInMeeting(ctx).find((person) => person.role === role) ?? {
      role,
      name: roleLabel(ctx.activeScenario(), role),
    }
  );
}

/** The name the AI facilitator speaks under, when that seat is an AI and not a person. */
function aiHostName(scenario: Scenario): string | undefined {
  const host = hostIdentityOf(scenario);
  if (host.name === undefined) return undefined;
  const playedByAi = (scenario.npcs ?? []).some((npc) => npc.attendee === host.name);
  return playedByAi ? host.name.trim().toLowerCase() : undefined;
}

/** True when the line is the AI facilitator's own agenda cue, which is never a fact or a question. */
function isAiHostLine(scenario: Scenario, line: WingmanLine): boolean {
  const host = aiHostName(scenario);
  if (host === undefined) return false;
  if (line.role !== undefined && hostIdentityOf(scenario).seat === line.role) return true;
  return speakerName(line.speaker).trim().toLowerCase() === host;
}

function isPersonSpeaking(line: WingmanLine, person: Person): boolean {
  if (line.role !== undefined && line.role === person.role) return true;
  return speakerName(line.speaker).trim().toLowerCase() === speakerName(person.name).trim().toLowerCase();
}

/** A stable key for one record so the same record is never sent to the same person twice. */
function recordKey(role: Role, fact: Fact): string {
  return `${role}\u0000${fact.source}\u0000${fact.text}`;
}

/** The module that privately helps one person keep up with the meeting they are in. */
export function createWingmanModule(options: WingmanModuleOptions = {}): KakiModule {
  return {
    name: 'wingman',
    start(ctx) {
      const env = options.env ?? process.env;
      const now = options.now ?? Date.now;
      const workspaceId = ctx.workspaceId();
      const recordRateLimitMs = options.recordRateLimitMs ?? DEFAULT_RECORD_RATE_LIMIT_MS;
      const askedCheckDelayMs = options.askedCheckDelayMs ?? DEFAULT_ASKED_CHECK_DELAY_MS;

      let search = options.search;
      let pool: Pool | undefined;
      const gateway = gatewayConfigFromEnv(env);
      if (search === undefined) {
        const missing = missingSearchEnv(env);
        if (gateway === undefined || missing.length > 0) {
          console.log(`kaki wingman: workspace search disabled (missing ${[...new Set(missing)].join(', ')})`);
        } else {
          pool = new Pool({ connectionString: env.POSTGRES_URL });
          // An idle connection dying (database restart) must not crash the server.
          pool.on('error', (error) => console.error('kaki wingman: workspace search database error', error));
          // Bound to this meeting's workspace: no query can read another workspace.
          search = createCompanySearchFromEnv(env, pool, workspaceId);
        }
      }

      const llm = options.llm ?? notetakerLlmFromEnv(env);
      if (llm === undefined) {
        console.warn('kaki wingman: no LLM configured; questions use workspace search only and no proactive notes fire');
      }

      let stopped = false;
      let generation = 0;
      let transcript: WingmanLine[] = [];
      const notes = new Map<string, NoteRecord>();
      const askedKeys = new Set<string>();
      const givenKeys = new Set<string>();
      const recordKeys = new Set<string>();
      const recordCheckedAt = new Map<Role, number>();
      const recordRunning = new Set<Role>();

      let askedTimer: ReturnType<typeof setTimeout> | undefined;
      let askedRunning = false;
      let askedPending = false;
      let lastRecordLineCount = 0;
      let latestRecord: { agendaIndex: number; openQuestions: string[] } | undefined;

      const searchEnabled = (): boolean =>
        search !== undefined &&
        !(ctx.packFree?.() === true && workspaceId === SAMPLE_WORKSPACE_ID);

      function publishNote(role: Role, payload: WingmanNotePayload, retainKey: string): void {
        ctx.hub.publish(
          { type: 'WINGMAN_NOTE', audience: { kind: 'role', role }, payload },
          { retainKey },
        );
        notes.set(payload.id, { role, retainKey, payload });
      }

      function clearNote(id: string): boolean {
        const record = notes.get(id);
        if (record === undefined) return false;
        notes.delete(id);
        ctx.hub.publish(
          {
            type: 'WINGMAN_NOTE',
            audience: { kind: 'role', role: record.role },
            payload: { ...record.payload, clears: true },
          },
          { retainKey: record.retainKey },
        );
        return true;
      }

      function clearAskedWhenSpeaking(line: WingmanLine): void {
        for (const person of peopleInMeeting(ctx)) {
          const id = `asked:${person.role}`;
          if (notes.has(id) && isPersonSpeaking(line, person)) clearNote(id);
        }
      }

      function scheduleAskedCheck(): void {
        if (llm === undefined || stopped) return;
        if (askedCheckDelayMs <= 0) {
          void runAskedCheck();
          return;
        }
        if (askedTimer !== undefined) return;
        askedTimer = setTimeout(() => {
          askedTimer = undefined;
          void runAskedCheck();
        }, askedCheckDelayMs);
        askedTimer.unref?.();
      }

      async function runAskedCheck(): Promise<void> {
        if (stopped || llm === undefined) return;
        if (askedRunning) {
          askedPending = true;
          return;
        }
        askedRunning = true;
        const startedIn = generation;
        try {
          const lines = transcript.slice(-MAX_ASKED_LINES);
          if (lines.length > 0) {
            await Promise.all(peopleInMeeting(ctx).map((person) => judgeAsked(person, lines, startedIn)));
          }
        } finally {
          askedRunning = false;
          if (askedPending) {
            askedPending = false;
            scheduleAskedCheck();
          }
        }
      }

      async function judgeAsked(person: Person, lines: WingmanLine[], startedIn: number): Promise<void> {
        if (stopped || startedIn !== generation) return;
        // While one act-now ask is open, no second one replaces it.
        if (notes.has(`asked:${person.role}`)) return;
        const latest = lines[lines.length - 1];
        if (latest === undefined) return;
        if (isPersonSpeaking(latest, person)) return;
        if (isAiHostLine(ctx.activeScenario(), latest)) return;
        try {
          const raw = await llm!.complete(askedMessages(person.name, lines), {
            json: true,
            schema: ASKED_SCHEMA,
          });
          if (stopped || startedIn !== generation || !llm || raw === '') return;
          const verdict = parseAskedReply(raw);
          if (verdict === undefined) return;
          const line = groundedLine(verdict.evidence, lines);
          if (line === undefined) {
            console.warn('kaki wingman: ignored a direct question whose quoted line is not in the transcript');
            return;
          }
          if (isPersonSpeaking(line, person) || isAiHostLine(ctx.activeScenario(), line)) return;
          const key = `${person.role}\u0000${normaliseKey(verdict.question)}`;
          if (askedKeys.has(key)) return;
          askedKeys.add(key);

          const facts = await workspaceFacts(verdict.question, person.role, MAX_ASKED_FACTS);
          publishNote(
            person.role,
            {
              id: `asked:${person.role}`,
              kind: 'asked_you',
              urgency: 'act_now',
              title: `${speakerName(line.speaker)} asked you`,
              text: `${speakerName(line.speaker)} asked you: ${verdict.question}`,
              questionText: verdict.question,
              ...(facts.length === 0 ? {} : { facts }),
              ...(facts.length === 0 ? {} : { sources: facts.map(factSource) }),
            },
            `wingman:${person.role}:asked`,
          );
        } catch (error) {
          console.error(`kaki wingman: could not judge a direct question for ${person.role}`, error);
        }
      }

      async function workspaceFacts(
        question: string,
        role: Role,
        limit: number,
      ): Promise<Fact[]> {
        if (search === undefined || !searchEnabled()) return [];
        try {
          const facts = await search(question, role);
          return facts.slice(0, limit);
        } catch (error) {
          console.error(`kaki wingman: workspace search failed for ${role}`, error);
          return [];
        }
      }

      function scheduleRecordCheck(): void {
        if (llm === undefined || search === undefined || !searchEnabled() || stopped) return;
        if (transcript.length <= lastRecordLineCount) return;
        lastRecordLineCount = transcript.length;
        const latest = transcript[transcript.length - 1];
        if (latest === undefined || isAiHostLine(ctx.activeScenario(), latest)) return;
        for (const person of peopleInMeeting(ctx)) void judgeRecord(person);
      }

      async function judgeRecord(person: Person): Promise<void> {
        if (stopped || llm === undefined) return;
        if (recordRunning.has(person.role)) return;
        const previous = recordCheckedAt.get(person.role);
        if (previous !== undefined && now() - previous < recordRateLimitMs) return;
        recordCheckedAt.set(person.role, now());
        recordRunning.add(person.role);
        const startedIn = generation;
        try {
          const scenario = ctx.activeScenario();
          const lines = transcript
            .slice(-MAX_RECORD_LINES)
            .filter((line) => !isAiHostLine(scenario, line));
          const query = lines.slice(-3).map((line) => line.text).join(' ').trim();
          if (query === '') return;
          let facts: Fact[];
          try {
            facts = await search!(query, person.role);
          } catch (error) {
            console.error(`kaki wingman: workspace search failed for ${person.role}`, error);
            return;
          }
          if (stopped || startedIn !== generation || facts.length === 0) return;
          const usable = facts.slice(0, MAX_RECORD_FACTS);
          const raw = await llm.complete(recordMessages(person.name, lines, usable), {
            json: true,
            schema: RECORD_SCHEMA,
          });
          if (stopped || startedIn !== generation) return;
          const verdict = parseRecordReply(raw);
          if (verdict === undefined) return;
          const fact = usable.find(
            (candidate) => candidate.source === verdict.source && candidate.text.includes(verdict.snippet),
          );
          if (fact === undefined) {
            console.warn('kaki wingman: ignored a record note whose snippet is not verbatim from that record');
            return;
          }
          const key = recordKey(person.role, fact);
          if (recordKeys.has(key)) return;
          recordKeys.add(key);
          publishNote(
            person.role,
            {
              id: `record:${person.role}:${recordKeys.size}`,
              kind: 'record',
              urgency: 'quiet',
              title: 'Records on this',
              text: `${verdict.verdict === 'answers' ? 'This record answers what you are discussing' : 'This record contradicts what you are discussing'}: ${verdict.snippet} (${fact.source}, ${fact.date})`,
              facts: [fact],
              sources: [factSource(fact)],
            },
            `wingman:${person.role}:record:${recordKeys.size}`,
          );
        } catch (error) {
          console.error(`kaki wingman: could not judge a workspace record for ${person.role}`, error);
        } finally {
          recordRunning.delete(person.role);
        }
      }

      async function answerQuestion(person: Person, question: string): Promise<void> {
        if (stopped) return;
        const startedIn = generation;
        const lines = transcript.slice(-MAX_ASK_LINES);
        const tasks = ctx.tasks.list();
        let parts: AnswerPart[] = [];
        let meetingFailed = false;
        if (llm !== undefined && lines.length > 0) {
          try {
            const scenario = ctx.activeScenario();
            const raw = await llm.complete(
              askMessages(
                scenario,
                person.name,
                person.role,
                question,
                {
                  ...(latestRecord === undefined
                    ? {}
                    : { agendaTitle: scenario.agenda[latestRecord.agendaIndex]?.title as string | undefined }),
                  openQuestions: latestRecord?.openQuestions ?? [],
                },
                lines,
                tasks,
              ),
              { json: true, schema: ASK_SCHEMA },
            );
            parts = parseAskReply(raw, lines, tasks);
          } catch (error) {
            meetingFailed = true;
            console.error(`kaki wingman: could not answer for ${person.role} from the meeting`, error);
          }
        }

        let facts: Fact[] = [];
        let searchFailed = false;
        if (search !== undefined && searchEnabled()) {
          try {
            facts = (await search(question, person.role)).slice(0, MAX_RECORD_FACTS);
          } catch (error) {
            searchFailed = true;
            console.error(`kaki wingman: workspace search failed for ${person.role}`, error);
          }
        }

        const linesOut: string[] = parts.map((part) => part.text);
        linesOut.push(...facts.map((fact) => fact.text));
        if (searchFailed) linesOut.push(SEARCH_FAILED_TEXT);
        if (meetingFailed && parts.length === 0 && facts.length === 0 && !searchFailed) {
          linesOut.push(MEETING_FAILED_TEXT);
        }
        if (stopped || startedIn !== generation) return;
        const text = linesOut.length === 0 ? NOTHING_TEXT : linesOut.join('\n');
        const sources = [...parts.map((part) => part.source), ...facts.map(factSource)];
        publishNote(
          person.role,
          {
            id: `answer:${person.role}`,
            kind: 'answer',
            urgency: 'quiet',
            title: 'Wingman',
            text,
            ...(facts.length === 0 ? {} : { facts }),
            ...(sources.length === 0 ? {} : { sources: [...new Set(sources)] }),
            questionText: question,
          },
          `wingman:${person.role}:answer`,
        );
      }

      function giveTaskNote(task: Task, role: Role): void {
        const key = `${task.id}\u0000${role}`;
        if (givenKeys.has(key)) return;
        if (task.status === 'DISMISSED' || task.status === 'SUPERSEDED') return;
        givenKeys.add(key);
        publishNote(
          role,
          {
            id: `given:${role}:${task.id}`,
            kind: 'given',
            urgency: 'quiet',
            title: 'You were given a to-do',
            text: `You were given: ${task.title}. Accept or change it on the card.`,
          },
          `wingman:${role}:given:${task.id}`,
        );
      }

      // Index the ended meeting's minutes and to-dos into this workspace, exactly as before.
      let indexedMeeting: { meetingId: string; text: string } | undefined;
      let meetingQueue: Promise<void> = Promise.resolve();
      const indexEndedMeeting = (minutes?: string): void => {
        const db = pool;
        if (db === undefined || gateway === undefined || stopped) return;
        const meetingId = ctx.meetingId();
        const scenario = ctx.activeScenario();
        const date = isoDay(new Date());
        const text = meetingKnowledgeText({
          title: scenario.meetingTitle,
          date,
          agenda: scenario.agenda,
          tasks: ctx.tasks.list(),
          ...(minutes === undefined ? {} : { minutes }),
        });
        if (indexedMeeting?.meetingId === meetingId && indexedMeeting.text === text) return;
        indexedMeeting = { meetingId, text };
        // Index in order: the closing pass (to-dos only) first, then the pass with the minutes, so
        // the newer record always wins the shared ref.
        meetingQueue = meetingQueue
          .catch(() => undefined)
          .then(() => {
            if (stopped) return;
            return indexMeetingRecord({
              db,
              workspaceId,
              meetingId,
              title: scenario.meetingTitle,
              text,
              publishedAt: date,
              gateway,
            });
          })
          .catch((error: unknown) =>
            console.error(
              `kaki wingman: indexing meeting ${meetingId} for workspace ${workspaceId} failed`,
              error,
            ),
          );
      };

      function handleTranscript(event: Extract<KakiEvent, { type: 'TRANSCRIPT_CHUNK' }>): void {
        const line: WingmanLine = {
          speaker: event.payload.speaker,
          text: event.payload.text,
          timestamp: event.payload.timestamp,
          ...(event.payload.speakerRole === undefined ? {} : { role: event.payload.speakerRole }),
        };
        transcript = [...transcript, line].slice(-MAX_TRANSCRIPT_LINES);
        clearAskedWhenSpeaking(line);
        scheduleAskedCheck();
      }

      function handleTask(event: Extract<KakiEvent, { type: 'TASK_UPDATED' }>): void {
        const { task } = event.payload;
        const people = peopleInMeeting(ctx);
        for (const person of people) {
          if (task.assignee !== person.role && task.suggestedAssignee !== person.role) continue;
          giveTaskNote(task, person.role);
        }
      }

      function reset(): void {
        generation += 1;
        transcript = [];
        notes.clear();
        askedKeys.clear();
        givenKeys.clear();
        recordKeys.clear();
        recordCheckedAt.clear();
        recordRunning.clear();
        lastRecordLineCount = 0;
        latestRecord = undefined;
        if (askedTimer !== undefined) clearTimeout(askedTimer);
        askedTimer = undefined;
        askedRunning = false;
        askedPending = false;
        indexedMeeting = undefined;
      }

      const unsubscribe = ctx.hub.subscribe((event) => {
        if (stopped) return;
        if (event.type === 'MEETING_RESET') {
          reset();
          return;
        }
        if (event.type === 'HOST_SPEECH_TRIGGERED' && event.payload.kind === 'CLOSING') {
          indexEndedMeeting();
        } else if (
          event.type === 'TASK_UPDATED' &&
          event.payload.task.purpose === 'meeting_minutes' &&
          (event.payload.task.status === 'DRAFT_READY' ||
            event.payload.task.status === 'COMPLETED' ||
            event.payload.task.status === 'SYNCED') &&
          event.payload.task.draft !== undefined
        ) {
          indexEndedMeeting(event.payload.task.draft.body);
        }
        if (event.type === 'TRANSCRIPT_CHUNK') {
          handleTranscript(event);
          return;
        }
        if (event.type === 'TASK_UPDATED') {
          handleTask(event);
          return;
        }
        if (event.type === 'MEETING_RECORD_UPDATED') {
          latestRecord = {
            agendaIndex: event.payload.agendaIndex,
            openQuestions: event.payload.openQuestions.map((question) => question.text),
          };
          scheduleRecordCheck();
        }
      });

      // A person's role socket and a practice meeting's own screen both act as that person's seat.
      function seatOf(sender: { kind: string; role?: Role }): Role | undefined {
        if (sender.kind === 'role') return sender.role;
        if (sender.kind === 'screen') return ctx.session?.practiceSeat();
        return undefined;
      }

      ctx.hub.onCommand((command, sender) => {
        if (command.type === 'ASK_WINGMAN') {
          const role = seatOf(sender);
          if (role === undefined) throw new CommandError('Only a person in a seat can ask the Wingman');
          const person = personFor(ctx, role);
          return { commit: () => answerQuestion(person, command.question) };
        }
        if (command.type === 'DISMISS_WINGMAN_NOTE') {
          const role = seatOf(sender);
          if (role === undefined) return;
          const record = notes.get(command.id);
          if (record === undefined || record.role !== role) return;
          clearNote(command.id);
        }
      });

      return () => {
        stopped = true;
        generation += 1;
        unsubscribe();
        if (askedTimer !== undefined) clearTimeout(askedTimer);
        if (pool) void pool.end();
      };
    },
  };
}

function normaliseKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function factSource(fact: Fact): string {
  return `${fact.source} (${fact.date})`;
}

