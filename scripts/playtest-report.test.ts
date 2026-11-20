import { describe, expect, it } from 'vitest';
import { reportResultLine, statusFor, summarizeChecks, type CheckStatus } from './playtest-report';

const statuses = (...values: CheckStatus[]): Array<{ status: CheckStatus }> => values.map((status) => ({ status }));

describe('playtest report status', () => {
  it('fails a hard miss, warns a soft miss, and passes a hit', () => {
    expect(statusFor(true)).toBe('PASS');
    expect(statusFor(false)).toBe('FAIL');
    expect(statusFor(false, 'warn')).toBe('WARN');
  });

  it('counts warnings and unexercised checks without failing the run', () => {
    expect(summarizeChecks(statuses('PASS', 'WARN', 'NOT EXERCISED'))).toEqual({
      result: 'PASS', warnings: 1, notExercised: 1,
    });
    expect(summarizeChecks(statuses('PASS', 'FAIL', 'NOT EXERCISED'))).toEqual({
      result: 'FAIL', warnings: 0, notExercised: 1,
    });
  });

  it('shows the counts in the report header', () => {
    expect(reportResultLine(statuses('PASS', 'WARN', 'NOT EXERCISED', 'NOT EXERCISED')))
      .toBe('Result: **PASS** · 1 warning(s) to review · 2 check(s) NOT EXERCISED');
    expect(reportResultLine(statuses('PASS'))).toBe('Result: **PASS**');
  });
});
