import type { Scenario } from '@kaki/shared';
import { createActionModules } from './action';
import type { KakiModule } from './core/modules';
import { createHostModules, type MeetingPauseControl } from './host';
import type { MeetingRow } from './meeting/types';
import { createWingmanModules } from './wingman';

/** The modules one meeting runs, with the agenda clock the app server reads to stamp and pause it. */
export interface MeetingModules {
  modules: KakiModule[];
  meetingElapsedSeconds: () => number | undefined;
  meetingAgendaIndex: () => number | undefined;
  meetingPaused: () => boolean | undefined;
  meetingPause: MeetingPauseControl;
}

/**
 * Fresh modules for one meeting instance: its own agenda clock, Wingman and Action modules. Never
 * share these between meetings; every module keeps its state inside `start(ctx)`.
 *
 * The scenario is the pack this meeting runs. Until workspaces own their knowledge (step 4), every
 * meeting of this server runs the same pack.
 */
export function createMeetingModules(_meeting: MeetingRow, scenario: Scenario): MeetingModules {
  const host = createHostModules({ ...scenario });
  return {
    modules: [...host.modules, ...createWingmanModules(), ...createActionModules()],
    meetingElapsedSeconds: host.meetingElapsedSeconds,
    meetingAgendaIndex: host.meetingAgendaIndex,
    meetingPaused: host.meetingPaused,
    meetingPause: host.meetingPause,
  };
}
