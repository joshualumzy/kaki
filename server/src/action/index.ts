import type { ActionKind } from '@kaki/shared';
import { llmFromEnv } from '../services/llm';
import type { KakiModule } from '../core/modules';
import { createCalendarModule } from './calendar';
import { createEmailModule } from './email';
import { createFitModule } from './fit';
import { createGiteaModule } from './gitea';
import { createMattermostModule } from './mattermost';
import { missingActionEnv } from './tools';
import { createWikiModule } from './wiki';

export { calendarFromEnv, missingActionEnv } from './tools';

/** Logs at startup which sample-workspace tools are unconfigured and what they are missing. */
export function logMissingActionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const entries = Object.entries(missingActionEnv(env)) as Array<[ActionKind, string[]]>;
  if (entries.length === 0) return;
  console.error(
    `kaki action: sample workspace tools are not configured: ${entries
      .map(([kind, names]) => `${kind} (missing ${names.join(', ')})`)
      .join('; ')}. Tasks that need them will fail at draft time instead of drafting.`,
  );
}

/**
 * Fresh Action modules for one meeting instance, one per tool. The modules read the meeting's
 * workspace tools through `ctx.tools()`, so two meetings never share a connection and no module
 * reads the environment itself.
 */
export function createActionModules(): KakiModule[] {
  const llm = llmFromEnv();
  return [
    createFitModule({ llm }),
    createGiteaModule({ llm }),
    createMattermostModule({ llm }),
    createEmailModule({ llm }),
    createWikiModule({ llm }),
    createCalendarModule({ llm }),
  ];
}
