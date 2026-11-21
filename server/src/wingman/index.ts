import type { KakiModule } from '../core/modules';
import { createKnowledgeModule } from './knowledge/module';
import { createNudgeModule } from './nudges/module';

/**
 * Fresh Wingman modules for one meeting instance. Each call builds new module objects, so two
 * meetings can never share the state a module creates when it starts.
 */
export function createWingmanModules(): KakiModule[] {
  return [createKnowledgeModule(), createNudgeModule()];
}
