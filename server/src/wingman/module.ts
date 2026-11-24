import {
  DEFAULT_MEETING_PACE,
  hostIdentityOf,
  humanRoles,
  roleLabel,
  speakerName,
  type Fact,
  type KakiEvent,
  type MeetingPace,
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
  NUDGE_SCHEMA,
  RECORD_SCHEMA,
  askMessages,
  askedMessages,
  groundedLine,
  nudgeMessages,
  parseAskedReply,
  parseAskReply,
  parseNudgeReply,
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
/** How much of the transcript a quiet-owner suggestion may read. */
const MAX_NUDGE_LINES = 40;
/** One quiet-owner suggestion is one short sentence, never a paragraph in the panel. */
const MAX_NUDGE_SUGGESTION_CHARS = 220;
/** A role id that only means "the whole room", never a person who can be nudged. */
const PLACEHOLDER_ROLE = 'everyone';

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
    (task) => task.purpose === undefined && task.status !== 'DISMISSED',
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
      let latestRecord: Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>['payload'] | undefined;
      /** Quiet-owner checks already taken for an agenda item, so each fires at most once. */
      const quietChecked = new Set<number>();
      /** Coming-up checks already taken for the item before the next one. */
      const comingUpChecked = new Set<number>();
      const ownerSkipLogged = new Set<number>();
      /** How many lines each present role has spoken this meeting, for discarding stale guesses. */
      const speechByRole = new Map<Role, number>();
      /** The quiet lead currently shown on the meeting owner's screen, if any. */
      let leadNote: { id: string; hostRole: Role; ownerRole: Role; agendaIndex: number } | undefined;

      const searchEnabled = (): boolean =>
        search !== undefined &&
        !(ctx.packFree?.() === true && workspaceId === SAMPLE_WORKSPACE_ID);

      let unknownGuestWarned = false;
      /**
       * A guest in a real meeting gets answers and notes from this meeting only: nothing the
       * workspace holds may reach them. Practice meetings keep their sample workspace.
       * An unknown identity fails closed as a guest, loudly once.
       */
      const isGuest = (role: Role): boolean => {
        if (ctx.meetingKind?.() !== 'real') return false;
        const guest = ctx.seatIsGuest?.(role);
        if (guest !== undefined) return guest;
        if (!unknownGuestWarned) {
          unknownGuestWarned = true;
          console.warn(
            'kaki wingman: the seat holder is unknown, so they are treated as a guest and workspace records stay private',
          );
        }
        return true;
      };

      function publishNote(role: Role, payload: WingmanNotePayload, retainKey: string): void {
        // The server owns the real time: a clear re-sends the stored copy, so its time never moves.
        const stamped: WingmanNotePayload = {
          ...payload,
          at: payload.at ?? new Date(now()).toISOString(),
        };
        ctx.hub.publish(
          { type: 'WINGMAN_NOTE', audience: { kind: 'role', role }, payload: stamped },
          { retainKey },
        );
        notes.set(payload.id, { role, retainKey, payload: stamped });
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

      /** The pace the owner sealed for this meeting, or the shipped default before a seal. */
      function sealedPace(): MeetingPace {
        return (
          ctx.session?.sealed()?.pace ??
          ctx.meetingDetails?.().sealed?.pace ??
          DEFAULT_MEETING_PACE
        );
      }

      function itemOwnerRole(agendaIndex: number): Role | undefined {
        const role = ctx.activeScenario().agenda[agendaIndex]?.ownerRole?.trim();
        if (role === undefined || role === '' || role === PLACEHOLDER_ROLE) return undefined;
        return role;
      }

      /** Resolve exactly one present holder by seat identity; display names are only labels. */
      function presentItemOwner(agendaIndex: number): Person | undefined {
        const role = itemOwnerRole(agendaIndex);
        const holders = (ctx.meetingDetails?.().holders ?? []).filter((holder) => holder.seat === role);
        const roles = ctx.activeScenario().roles.filter((entry) => entry.id === role);
        if (role !== undefined && holders.length === 1 && roles.length === 1) {
          const holder = holders[0]!;
          return { role, name: holder.displayName?.trim() || holder.name.trim() };
        }
        if (!ownerSkipLogged.has(agendaIndex)) {
          ownerSkipLogged.add(agendaIndex);
          const reason = role === undefined ? 'no uniquely resolved owner seat assigned'
            : holders.length === 0 ? 'owner seat is absent'
            : holders.length > 1 ? 'owner seat has multiple holders'
            : 'owner seat is not a unique scenario role';
          console.warn(`kaki wingman: agenda cues skipped for item ${agendaIndex + 1}: ${reason}`);
        }
        return undefined;
      }

      /** Real speech must identify its seat. Practice keeps its existing name matching. */
      function personIsSpeaking(line: WingmanLine, person: Person): boolean {
        return ctx.meetingKind?.() === 'real'
          ? line.role === person.role
          : isPersonSpeaking(line, person);
      }

      /** The meeting owner's seat: the shared screen also receives this seat's private notes. */
      function hostSeat(): Role | undefined {
        return hostIdentityOf(ctx.activeScenario()).seat;
      }

      function clearLead(): void {
        const lead = leadNote;
        if (lead === undefined) return;
        leadNote = undefined;
        clearNote(lead.id);
      }

      function shortenSuggestion(text: string): string {
        const firstLine = text.trim().split('\n')[0]?.trim() ?? '';
        if (firstLine.length <= MAX_NUDGE_SUGGESTION_CHARS) return firstLine;
        const cut = firstLine.slice(0, MAX_NUDGE_SUGGESTION_CHARS);
        const lastSpace = cut.lastIndexOf(' ');
        return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
      }

      function fireQuietLead(
        agendaIndex: number,
        owner: Person,
        hostRole: Role,
        ownerRole: Role,
        hasSpoken: boolean,
      ): void {
        const id = `lead:${agendaIndex}`;
        leadNote = { id, hostRole, ownerRole, agendaIndex };
        publishNote(
          hostRole,
          {
            id,
            kind: 'lead',
            urgency: 'quiet',
            title: 'Quiet agenda item',
            text: hasSpoken
              ? `${owner.name} owns this item but has said little so far.`
              : `${owner.name} owns this item but hasn't spoken yet.`,
          },
          `wingman:${hostRole}:lead:${agendaIndex}`,
        );
      }

      /** True while a quiet-owner guess still belongs to the room and the person it was made for. */
      function cueStillCurrent(
        agendaIndex: number,
        ownerRole: Role,
        startedIn: number,
        speechAtStart: number,
      ): boolean {
        if (stopped || startedIn !== generation || ctx.meetingKind?.() !== 'real') return false;
        if (ctx.session?.offTheRecordSince() !== undefined) return false;
        const record = latestRecord;
        if (
          record === undefined ||
          record.agendaIndex !== agendaIndex ||
          record.ended === true ||
          record.paused === true
        ) {
          return false;
        }
        if (presentItemOwner(agendaIndex)?.role !== ownerRole) return false;
        return (speechByRole.get(ownerRole) ?? 0) === speechAtStart;
      }

      async function fireQuietNudge(
        agendaIndex: number,
        itemTitle: string,
        owner: Person,
        openQuestions: readonly { text: string; agendaIndex: number }[],
      ): Promise<void> {
        const startedIn = generation;
        const speechAtStart = speechByRole.get(owner.role) ?? 0;
        const question = openQuestions.find((entry) => entry.agendaIndex === agendaIndex)?.text;
        const lines = transcript.slice(-MAX_NUDGE_LINES);
        let suggestion: string | undefined;
        if (llm === undefined) {
          console.error(
            `kaki wingman: no model to write the quiet-owner suggestion for ${owner.role} on "${itemTitle}"; publishing the plain note`,
          );
        } else {
          try {
            const raw = await llm.complete(
              nudgeMessages(ctx.activeScenario(), owner.name, owner.role, itemTitle, question, lines),
              { json: true, schema: NUDGE_SCHEMA },
            );
            if (stopped || startedIn !== generation) return;
            const verdict = parseNudgeReply(raw, lines);
            if (verdict === undefined) {
              console.error(
                `kaki wingman: the quiet-owner suggestion for ${owner.role} on "${itemTitle}" was not grounded in the transcript; publishing the plain note`,
              );
            } else {
              suggestion = shortenSuggestion(verdict.suggestion);
            }
          } catch (error) {
            console.error(
              `kaki wingman: could not write the quiet-owner suggestion for ${owner.role} on "${itemTitle}"; publishing the plain note`,
              error,
            );
          }
        }
        // Only a grounded suggestion is worth a workspace lookup. With none, the owner gets the
        // plain item and question note, never a record fetched for nothing.
        if (!cueStillCurrent(agendaIndex, owner.role, startedIn, speechAtStart)) return;
        let facts: Fact[] = [];
        if (suggestion !== undefined && suggestion !== '') {
          facts = await workspaceFacts(question ?? itemTitle, owner.role, MAX_RECORD_FACTS);
          // Membership or the workspace search can change while that lookup is in flight. Recheck
          // after the await so a person who became a guest, or lost search, gets no records or sources.
          if (isGuest(owner.role) || !searchEnabled()) facts = [];
        }
        if (!cueStillCurrent(agendaIndex, owner.role, startedIn, speechAtStart)) return;
        const text = [`You own "${itemTitle}".`];
        if (question !== undefined) text.push(`Open question: ${question}`);
        if (suggestion !== undefined && suggestion !== '') text.push(`Suggestion: ${suggestion}`);
        publishNote(
          owner.role,
          {
            id: `nudge:${owner.role}:${agendaIndex}`,
            kind: 'nudge',
            urgency: 'quiet',
            title: `Your item: ${itemTitle}`,
            text: text.join('\n'),
            ...(question === undefined ? {} : { questionText: question, questionFrom: 'room' as const }),
            ...(facts.length === 0 ? {} : { facts }),
            ...(facts.length === 0 ? {} : { sources: facts.map(factSource) }),
          },
          `wingman:${owner.role}:nudge:${agendaIndex}`,
        );
      }

      /** The two real-meeting pace cues, read from the record the host publishes every tick. */
      function handleAgendaCues(
        payload: Extract<KakiEvent, { type: 'MEETING_RECORD_UPDATED' }>['payload'],
      ): void {
        if (ctx.meetingKind?.() !== 'real') return;
        const hostRole = hostSeat();
        if (
          payload.ended === true ||
          payload.paused === true ||
          ctx.session?.offTheRecordSince() !== undefined
        ) {
          clearLead();
          return;
        }
        if (
          leadNote !== undefined &&
          (leadNote.agendaIndex !== payload.agendaIndex ||
            leadNote.hostRole !== hostRole ||
            presentItemOwner(leadNote.agendaIndex)?.role !== leadNote.ownerRole)
        ) {
          clearLead();
        }
        const item = ctx.activeScenario().agenda[payload.agendaIndex];
        if (item === undefined) return;
        const pace = sealedPace();
        const owner = presentItemOwner(payload.agendaIndex);
        if (
          owner !== undefined &&
          !quietChecked.has(payload.agendaIndex) &&
          payload.elapsedSeconds >= pace.quietCheckAfter
        ) {
          quietChecked.add(payload.agendaIndex);
          const talk = payload.speakerTalkSeconds[owner.role] ?? 0;
          if (talk < pace.ownerQuietBelow) {
            if (hostRole !== undefined) {
              fireQuietLead(payload.agendaIndex, owner, hostRole, owner.role, talk > 0);
            }
            void fireQuietNudge(payload.agendaIndex, item.title, owner, payload.openQuestions);
          }
        }

        if (comingUpChecked.has(payload.agendaIndex)) return;
        const next = ctx.activeScenario().agenda[payload.agendaIndex + 1];
        if (next === undefined) return;
        const remaining = item.minutes * 60 - payload.elapsedSeconds;
        if (remaining <= 0 || remaining > pace.comingUpBefore) return;
        const nextOwner = presentItemOwner(payload.agendaIndex + 1);
        if (nextOwner === undefined) return;
        comingUpChecked.add(payload.agendaIndex);
        const minutes = Math.max(1, Math.ceil(remaining / 60));
        publishNote(
          nextOwner.role,
          {
            id: `upcoming:${nextOwner.role}:${payload.agendaIndex}`,
            kind: 'nudge',
            urgency: 'quiet',
            title: 'Your next item',
            text: `Up next in about ${minutes} min: ${next.title}, it's yours.`,
          },
          `wingman:${nextOwner.role}:upcoming:${payload.agendaIndex}`,
        );
      }

      function clearAskedWhenSpeaking(line: WingmanLine): void {
        for (const person of peopleInMeeting(ctx)) {
          const id = `asked:${person.role}`;
          if (notes.has(id) && personIsSpeaking(line, person)) clearNote(id);
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
        if (personIsSpeaking(latest, person)) return;
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
          if (personIsSpeaking(line, person) || isAiHostLine(ctx.activeScenario(), line)) return;
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
              text: verdict.question,
              questionText: verdict.question,
              questionFrom: 'person',
              askedBy: speakerName(line.speaker),
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
        if (search === undefined || !searchEnabled() || isGuest(role)) return [];
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
        for (const person of peopleInMeeting(ctx)) {
          if (!isGuest(person.role)) void judgeRecord(person);
        }
      }

      async function judgeRecord(person: Person): Promise<void> {
        if (stopped || llm === undefined || isGuest(person.role)) return;
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
                  openQuestions: latestRecord?.openQuestions.map((entry) => entry.text) ?? [],
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
        if (search !== undefined && searchEnabled() && !isGuest(person.role)) {
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
            questionFrom: 'you',
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
        for (const person of peopleInMeeting(ctx)) {
          if (!personIsSpeaking(line, person)) continue;
          speechByRole.set(person.role, (speechByRole.get(person.role) ?? 0) + 1);
          if (leadNote?.ownerRole === person.role) clearLead();
        }
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
        quietChecked.clear();
        comingUpChecked.clear();
        ownerSkipLogged.clear();
        speechByRole.clear();
        leadNote = undefined;
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
          latestRecord = event.payload;
          scheduleRecordCheck();
          handleAgendaCues(event.payload);
        }
      });

      // A person's role socket and a meeting's own screen both act as that person's seat. A real
      // meeting's screen is the host's: it acts as the facilitator's plain seat when that person is
      // in the room, so the owner can ask their own Wingman just as any participant can.
      function seatOf(sender: { kind: string; role?: Role }): Role | undefined {
        if (sender.kind === 'role') return sender.role;
        if (sender.kind === 'screen') {
          const practice = ctx.session?.practiceSeat();
          if (practice !== undefined) return practice;
          const facilitator = ctx.activeScenario().roles.find((role) => role.facilitator === true);
          if (facilitator === undefined) return undefined;
          const held = (ctx.meetingDetails?.().holders ?? []).some((holder) => holder.seat === facilitator.id);
          return held ? facilitator.id : undefined;
        }
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

