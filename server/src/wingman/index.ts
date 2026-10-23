import type { KakiModule } from '../modules';
import { knowledgeModule } from './knowledge/module';
import { nudgeModule } from './nudges/module';

/** Modules the Wingman team plugs into the meeting server. */
export const wingmanModules: KakiModule[] = [knowledgeModule, nudgeModule];
