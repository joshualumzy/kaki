import type { ActionKind } from '@kaki/shared';
import { llmFromEnv } from '../llm';
import type { KakiModule } from '../modules';
import { createCalendarModule } from './calendar';
import { createEmailModule } from './email';
import { createGiteaModule } from './gitea';
import { createMattermostModule } from './mattermost';
import {
  calendarFromEnv,
  emailFromEnv,
  giteaFromEnv,
  mattermostFromEnv,
  missingActionEnv,
  wikiFromEnv,
} from './tools';
import { createWikiModule } from './wiki';

export { calendarFromEnv, missingActionEnv } from './tools';

export function logMissingActionConfig(env: NodeJS.ProcessEnv = process.env): void {
  const entries = Object.entries(missingActionEnv(env)) as Array<[ActionKind, string[]]>;
  if (entries.length === 0) return;
  console.error(
    `kaki action: tools are not configured: ${entries
      .map(([kind, names]) => `${kind} (missing ${names.join(', ')})`)
      .join('; ')}. Tasks that need them will fail at draft time instead of drafting.`,
  );
}

const llm = llmFromEnv();

export const actionModules: KakiModule[] = [
  createGiteaModule({
    llm,
    gitea: giteaFromEnv(),
  }),
  createMattermostModule({
    llm,
    mattermost: mattermostFromEnv(),
  }),
  createEmailModule({
    llm,
    email: emailFromEnv(),
  }),
  createWikiModule({
    llm,
    wiki: wikiFromEnv(),
  }),
  createCalendarModule({
    llm,
    calendar: calendarFromEnv(),
  }),
];
