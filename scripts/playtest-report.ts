/** Status accounting for the live playtest report. */

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NOT EXERCISED';

export type PlaytestCheck = {
  at: string;
  name: string;
  status: CheckStatus;
  detail: string;
  shot?: string;
};

/** A miss is a WARN only when the caller asked for a soft check; a pass is always PASS. */
export function statusFor(ok: boolean, severity: 'fail' | 'warn' = 'fail'): CheckStatus {
  return ok ? 'PASS' : severity === 'warn' ? 'WARN' : 'FAIL';
}

interface CheckSummary {
  result: 'PASS' | 'FAIL';
  warnings: number;
  notExercised: number;
}

export function summarizeChecks(checks: readonly Pick<PlaytestCheck, 'status'>[]): CheckSummary {
  const result = checks.some((item) => item.status === 'FAIL') ? 'FAIL' : 'PASS';
  const warnings = checks.filter((item) => item.status === 'WARN').length;
  const notExercised = checks.filter((item) => item.status === 'NOT EXERCISED').length;
  return { result, warnings, notExercised };
}

/** The markdown result line, with warnings and unexercised checks counted in the header. */
export function reportResultLine(checks: readonly Pick<PlaytestCheck, 'status'>[]): string {
  const summary = summarizeChecks(checks);
  const parts = [`Result: **${summary.result}**`];
  if (summary.warnings > 0) parts.push(`${summary.warnings} warning(s) to review`);
  if (summary.notExercised > 0) parts.push(`${summary.notExercised} check(s) NOT EXERCISED`);
  return parts.join(' · ');
}
