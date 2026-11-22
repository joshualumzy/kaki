import type { KakiModule } from '../core/modules';
import { createWingmanModule } from './module';

/**
 * Fresh Wingman modules for one meeting instance. Each call builds a new module object, so two
 * meetings can never share the transcript, notes or rate limits a module creates when it starts.
 */
export function createWingmanModules(): KakiModule[] {
  return [createWingmanModule()];
}
