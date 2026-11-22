import type { Scenario } from '@kaki/shared';
import { createActionModules } from './action';
import type { KakiModule } from './core/modules';
import { createHostModules, type MeetingPauseControl } from './host';
import type { MeetingRow } from './meeting/types';
import { realBaseScenario } from './meeting/realMeeting';
import type { WorkspaceToolSource, WorkspaceTools } from './workspace/tools';
import { createWingmanModules } from './wingman';

/** The modules one meeting runs, with the agenda clock the app server reads to stamp and pause it. */
export interface MeetingModules {
  modules: KakiModule[];
  /** The tools of this meeting's workspace, bound to the meeting the modules run for. */
  tools?: () => Promise<WorkspaceTools>;
  meetingElapsedSeconds: () => number | undefined;
  meetingAgendaIndex: () => number | undefined;
  meetingPaused: () => boolean | undefined;
  meetingPause: MeetingPauseControl;
}

/**
 * Fresh modules for one meeting instance: its own agenda clock, Wingman and Action modules. Never
 * share these between meetings; every module keeps its state inside `start(ctx)`.
 *
 * The scenario is the pack this meeting runs. The tool source is bound to the meeting's workspace,
 * so an action can only ever use that workspace's connections.
 */
export function createMeetingModules(
  meeting: MeetingRow,
  _scenario: Scenario,
  toolSource: WorkspaceToolSource,
): MeetingModules {
  // A real meeting's clock and notetaker follow its own title and agenda, never the demo pack.
  const host = createHostModules(realBaseScenario(meeting));
  return {
    modules: [...host.modules, ...createWingmanModules(), ...createActionModules()],
    tools: () => toolSource.toolsFor(meeting.workspaceId),
    meetingElapsedSeconds: host.meetingElapsedSeconds,
    meetingAgendaIndex: host.meetingAgendaIndex,
    meetingPaused: host.meetingPaused,
    meetingPause: host.meetingPause,
  };
}
