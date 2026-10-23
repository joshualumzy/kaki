import type { KakiModule } from '../modules';
import { fakeActionsModule } from './fakeActions';

/** Development-only modules; fake actions run only when explicitly enabled. */
export const devModules: KakiModule[] =
  process.env.NODE_ENV !== 'production' && process.env.KAKI_FAKE_ACTIONS === '1' ? [fakeActionsModule] : [];
