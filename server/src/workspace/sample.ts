import { SAMPLE_WORKSPACE_ID } from './constants';

/**
 * The built-in sample workspace. It is never a row: every signed-in user sees it, it is read-only,
 * and its tools are the hosted services the practice meeting already has.
 */
export const SAMPLE_WORKSPACE = {
  id: SAMPLE_WORKSPACE_ID,
  name: 'Nanyang Kopi (sample)',
  kind: 'sample',
  readOnly: true,
} as const;
