import type { Role } from './roles';
import type { Task } from './task';

/** One retrieved fact plus where it came from. */
export type Fact = { text: string; source: string; date: string };

/** Looks up company facts for a question, on behalf of one role. */
export type SearchCompanyData = (question: string, role: Role) => Promise<Fact[]>;

/** Outcome of a background action: an artifact URL or a loud failure. */
export type ActionResult = { ok: true; url: string } | { ok: false; error: string };

/** Runs a claimed task's background action. */
export type RunAction = (task: Task) => Promise<ActionResult>;
