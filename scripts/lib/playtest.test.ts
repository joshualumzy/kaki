import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../../server/src/llm';
import {
  errorMessage,
  escapeCell,
  modelFailureKind,
  parseArgv,
  stamp,
  writeMarkdownReport,
} from './playtest';

describe('stamp', () => {
  it('returns an ISO timestamp', () => {
    const value = stamp();
    expect(new Date(value).toISOString()).toBe(value);
  });
});

describe('escapeCell', () => {
  it('escapes pipes and folds newlines', () => {
    expect(escapeCell('a | b\r\nc\nd')).toBe('a \\| b c d');
  });
});

describe('errorMessage', () => {
  it('reads an Error message and stringifies anything else', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('modelFailureKind', () => {
  it('names the request failure, a known reply error, or a generic failure', () => {
    expect(modelFailureKind(new LlmError('down'))).toBe('model request failed');
    expect(modelFailureKind(new Error('bad reply'), (error) => (error instanceof Error ? error.message : undefined))).toBe('bad reply');
    expect(modelFailureKind(new Error('other'))).toBe('model call failed');
  });
});

describe('parseArgv', () => {
  const spec = { booleans: ['--headless'], values: ['--max-minutes', '--role'] };

  it('reads boolean flags and values from index 2 onward', () => {
    const args = parseArgv(['node', 'script', '--headless', '--max-minutes', '10', '--role', 'Ana'], spec);
    expect(args.has('--headless')).toBe(true);
    expect(args.value('--max-minutes')).toBe('10');
    expect(args.value('--role')).toBe('Ana');
  });

  it('lets the last repeated value win', () => {
    const args = parseArgv(['node', 'script', '--role', 'Ana', '--role', 'Ben'], spec);
    expect(args.value('--role')).toBe('Ben');
  });

  it('rejects an unknown flag or a value flag with no value', () => {
    expect(() => parseArgv(['node', 'script', '--nope'], spec)).toThrow('Unknown or incomplete argument: --nope');
    expect(() => parseArgv(['node', 'script', '--max-minutes'], spec)).toThrow(
      'Unknown or incomplete argument: --max-minutes',
    );
  });
});

describe('writeMarkdownReport', () => {
  it('creates the directory and writes the joined lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kaki-report-'));
    try {
      const path = join(dir, 'nested', 'report.md');
      await writeMarkdownReport(path, ['# Report', 'one']);
      await expect(readFile(path, 'utf8')).resolves.toBe('# Report\none');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
