import type { KakiModule } from '../modules';
import { knowledgeModule } from './knowledge/module';

/** Modules the Wingman team plugs into the meeting server. */
export const wingmanModules: KakiModule[] = [knowledgeModule];
