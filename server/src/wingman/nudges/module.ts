import type { KakiEvent, Role, SearchCompanyData } from '@kaki/shared';
import { Pool } from 'pg';
import type { KakiContext, KakiModule } from '../../modules';
import { gatewayConfigFromEnv, missingGatewayEnv } from '../knowledge/gateway';
import { createCompanySearchFromEnv } from '../knowledge/search';

const COMING_UP_WINDOW_SECONDS = 60;
const QUIET_RUNNING_SECONDS = 120;
const QUIET_TALK_SECONDS = 30;

export interface NudgeModuleOptions {
  /** A prepared search, used by tests and the check script. */
  search?: SearchCompanyData;
  env?: NodeJS.ProcessEnv;
}

type NudgeKind = 'coming_up' | 'quiet_owner';

interface NudgeRequest {
  kind: NudgeKind;
  /** The agenda item the nudge is about; part of the key late phones get it by. */
  agendaIndex: number;
  role: Role;
  topic: string;
  /** Seconds until the next item starts, or seconds left in the current item. */
  seconds: number;
}

function missingSearchEnv(env: NodeJS.ProcessEnv): string[] {
  return [...missingGatewayEnv(env), ...(env.POSTGRES_URL ? [] : ['POSTGRES_URL'])];
}

function minutesLabel(seconds: number): string {
  return `${Math.max(0, Math.ceil(seconds / 60))} min`;
}

function timeText(request: NudgeRequest): string {
  if (request.kind === 'coming_up') {
    return request.seconds <= 0 ? 'starts now' : `starts in ${minutesLabel(request.seconds)}`;
  }
  return request.seconds <= 0 ? 'has no time left' : `has ${minutesLabel(request.seconds)} left`;
}

function nudgeText(request: NudgeRequest, factText: string | undefined): string {
  const lead = `${request.topic} ${timeText(request)}.`;
  if (factText === undefined) {
    return `${lead} No company records were found on this. Ask the room for the details.`;
  }
  return `${lead} ${factText} Tap the fact card to read the details.`;
}

function sendNudge(ctx: KakiContext, search: SearchCompanyData, request: NudgeRequest): void {
  void (async () => {
    let factText: string | undefined;
    try {
      const facts = await search(request.topic, request.role);
      factText = facts[0]?.text.trim();
      if (factText === undefined || factText.length === 0) {
        factText = undefined;
        console.error(
          `kaki wingman: no company facts found for nudge on "${request.topic}" (${request.role})`,
        );
      }
    } catch (error) {
      console.error(
        `kaki wingman: company search failed for nudge on "${request.topic}" (${request.role}):`,
        error,
      );
    }

    try {
      ctx.hub.publish(
        {
          type: 'NUDGE',
          audience: { kind: 'role', role: request.role },
          payload: { text: nudgeText(request, factText) },
        },
        { retainKey: `nudge:${request.kind}:${request.agendaIndex}` },
      );
    } catch (error) {
      console.error(
        `kaki wingman: failed to publish nudge on "${request.topic}" (${request.role}):`,
        error,
      );
    }
  })();
}

function handleEvent(
  ctx: KakiContext,
  search: SearchCompanyData,
  fired: Set<string>,
  event: KakiEvent,
): void {
  if (event.type === 'MEETING_RESET') {
    fired.clear();
    return;
  }
  if (event.type !== 'MEETING_RECORD_UPDATED') return;

  const { agendaIndex, elapsedSeconds, speakerTalkSeconds } = event.payload;
  const agenda = ctx.scenario.agenda;
  const current = agenda[agendaIndex];
  if (current === undefined) return;

  // elapsedSeconds counts from the start of the current agenda item, not the meeting.
  const secondsLeft = current.minutes * 60 - elapsedSeconds;

  const quietKey = `quiet_owner:${agendaIndex}`;
  if (!fired.has(quietKey) && elapsedSeconds >= QUIET_RUNNING_SECONDS) {
    const talked = speakerTalkSeconds[current.ownerRole] ?? 0;
    if (talked < QUIET_TALK_SECONDS) {
      fired.add(quietKey);
      sendNudge(ctx, search, {
        kind: 'quiet_owner',
        agendaIndex,
        role: current.ownerRole,
        topic: current.title,
        seconds: secondsLeft,
      });
    }
  }

  const nextIndex = agendaIndex + 1;
  const next = agenda[nextIndex];
  if (next === undefined || next.ownerRole === current.ownerRole) return;

  const comingUpKey = `coming_up:${nextIndex}`;
  if (!fired.has(comingUpKey) && secondsLeft <= COMING_UP_WINDOW_SECONDS) {
    fired.add(comingUpKey);
    sendNudge(ctx, search, {
      kind: 'coming_up',
      agendaIndex: nextIndex,
      role: next.ownerRole,
      topic: next.title,
      seconds: secondsLeft,
    });
  }
}

/** The module that nudges owners about what is coming up and quiet agenda owners. */
export function createNudgeModule(options: NudgeModuleOptions = {}): KakiModule {
  return {
    name: 'wingman-nudges',
    start(ctx) {
      const env = options.env ?? process.env;
      let search = options.search;
      let pool: Pool | undefined;

      if (search === undefined) {
        const missing = missingSearchEnv(env);
        if (gatewayConfigFromEnv(env) === undefined || missing.length > 0) {
          console.log(
            `kaki wingman: nudges disabled (missing ${[...new Set(missing)].join(', ')})`,
          );
          return;
        }
        pool = new Pool({ connectionString: env.POSTGRES_URL });
        // An idle connection dying (database restart) must not crash the server.
        pool.on('error', (error) => console.error('kaki wingman: nudge database error', error));
        search = createCompanySearchFromEnv(env, pool);
      }

      const activeSearch = search;
      const fired = new Set<string>();
      const unsubscribe = ctx.hub.subscribe((event) => {
        try {
          handleEvent(ctx, activeSearch, fired, event);
        } catch (error) {
          console.error('kaki wingman: nudge subscriber failed', error);
        }
      });
      return () => {
        unsubscribe();
        if (pool) void pool.end();
      };
    },
  };
}

export const nudgeModule = createNudgeModule();
