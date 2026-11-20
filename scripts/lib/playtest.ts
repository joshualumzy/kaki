import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errorMessage } from '@kaki/shared';
import { LlmError } from '../../server/src/llm';

export { errorMessage };

/** The current time as an ISO string, used for every report row. */
export function stamp(): string {
  return new Date().toISOString();
}

/** Make one Markdown table cell safe: escape pipes and fold newlines to spaces. */
export function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Write a Markdown report, creating its directory first. */
export async function writeMarkdownReport(reportPath: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, lines.join('\n'));
}

/** How a model call failed: the request itself, a known reply error, or a generic failure. */
export function modelFailureKind(error: unknown, known?: (error: unknown) => string | undefined): string {
  if (error instanceof LlmError) return 'model request failed';
  return known?.(error) ?? 'model call failed';
}

/** The flags present and the values given on the command line, after validating every argument. */
export interface ParsedFlags {
  has(flag: string): boolean;
  value(flag: string): string | undefined;
}

/** Read `process.argv` from index 2, accepting only the named boolean and value flags. */
export function parseArgv(
  argv: readonly string[],
  options: { booleans?: readonly string[]; values?: readonly string[] },
): ParsedFlags {
  const booleans = new Set(options.booleans ?? []);
  const values = new Set(options.values ?? []);
  const flags = new Set<string>();
  const parsed = new Map<string, string>();

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (booleans.has(arg)) {
      flags.add(arg);
      continue;
    }
    const next = argv[i + 1];
    if (values.has(arg) && next !== undefined) {
      parsed.set(arg, next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${arg}`);
  }

  return { has: (flag) => flags.has(flag), value: (flag) => parsed.get(flag) };
}
