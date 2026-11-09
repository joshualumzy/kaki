import type { Scenario } from '@kaki/shared';
import type { Hub } from './hub';
import type { TaskStore } from './tasks';

/** Everything a plug-in module may use while the meeting runs. */
export interface KakiContext {
  hub: Hub;
  tasks: TaskStore;
  scenario: Scenario;
  /** When true, actions may be drafted and reviewed but never sent to external services. */
  draftOnly?: boolean;
}

/** A team-owned feature that plugs into the server without editing shared files. */
export interface KakiModule {
  name: string;
  start(ctx: KakiContext): void | (() => void);
}
