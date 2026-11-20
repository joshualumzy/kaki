import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLlmUse, formatLlmUseResult, parseLlmUseArgs, retargetLlmEnv } from '../../../scripts/llm-use';

const DIRECT_PRIMARY = [
  'PORT=3001',
  '# primary',
  'KAKI_LLM_BASE_URL=https://api.deepseek.com/v1',
  'KAKI_LLM_API_KEY=direct-key',
  'KAKI_LLM_MODEL=deepseek-chat',
  'KAKI_LLM_REASONING_CONTROL=false # main switch',
  '# fallback',
  'KAKI_LLM_FALLBACK_BASE_URL=https://school.example/v1',
  'KAKI_LLM_FALLBACK_API_KEY=school-key',
  'KAKI_LLM_FALLBACK_MODEL=x-test-2',
  'KAKI_EMBED_BASE_URL=https://school.example/v1',
  'OTHER=keep',
  '',
].join('\n');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempEnv(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'llm-use-'));
  tempDirs.push(dir);
  const envPath = join(dir, '.env');
  writeFileSync(envPath, content);
  return envPath;
}

describe('retargetLlmEnv', () => {
  it('moves DeepSeek between the slots, moving a one-sided reasoning line with it', () => {
    const { content, result } = retargetLlmEnv(DIRECT_PRIMARY, 'school');

    expect(result).toMatchObject({
      mode: 'school',
      changed: true,
      mainModel: 'x-test-2',
      mainHost: 'school.example',
      fallbackModel: 'deepseek-chat',
      fallbackHost: 'api.deepseek.com',
    });
    expect(content).toContain('KAKI_LLM_BASE_URL=https://school.example/v1');
    expect(content).toContain('KAKI_LLM_MODEL=x-test-2');
    expect(content).toContain('KAKI_LLM_FALLBACK_BASE_URL=https://api.deepseek.com/v1');
    expect(content).toContain('KAKI_LLM_FALLBACK_MODEL=deepseek-chat');
    expect(content).toContain('KAKI_LLM_FALLBACK_REASONING_CONTROL=false # main switch');
    expect(content).not.toContain('\nKAKI_LLM_REASONING_CONTROL=');
    expect(content).toContain('PORT=3001');
    expect(content).toContain('# primary');
    expect(content).toContain('# fallback');
    expect(content).toContain('OTHER=keep');
  });

  it('round-trips back to the original text', () => {
    const school = retargetLlmEnv(DIRECT_PRIMARY, 'school').content;
    const direct = retargetLlmEnv(school, 'direct');
    expect(direct.result.changed).toBe(true);
    expect(direct.content).toBe(DIRECT_PRIMARY);
  });

  it('is idempotent when the wanted slot already holds DeepSeek', () => {
    for (const mode of ['direct', 'school'] as const) {
      const first = retargetLlmEnv(DIRECT_PRIMARY, mode).content;
      const again = retargetLlmEnv(first, mode);
      expect(again.result.changed).toBe(false);
      expect(again.content).toBe(first);
    }
  });

  it('refuses duplicates, missing keys, and an ambiguous DeepSeek slot', () => {
    expect(() => retargetLlmEnv(`${DIRECT_PRIMARY}KAKI_LLM_MODEL=again\n`, 'school')).toThrow(/duplicate key/);
    expect(() =>
      retargetLlmEnv(DIRECT_PRIMARY.replace('KAKI_LLM_FALLBACK_MODEL=x-test-2\n', ''), 'school'),
    ).toThrow(/required key KAKI_LLM_FALLBACK_MODEL is missing/);
    expect(() =>
      retargetLlmEnv(
        DIRECT_PRIMARY.replace(
          'KAKI_LLM_FALLBACK_BASE_URL=https://school.example/v1',
          'KAKI_LLM_FALLBACK_BASE_URL=https://api.deepseek.com/v1',
        ),
        'school',
      ),
    ).toThrow(/both slots/);
    expect(() =>
      retargetLlmEnv(
        DIRECT_PRIMARY.replace(
          'KAKI_LLM_BASE_URL=https://api.deepseek.com/v1',
          'KAKI_LLM_BASE_URL=https://school.example/v1',
        ),
        'school',
      ),
    ).toThrow(/neither slot/);
  });
});

describe('embedding gateway guard', () => {
  it('refuses to swap while embeddings still follow the fallback slot, but allows a no-op', () => {
    const unpinned = DIRECT_PRIMARY.replace('KAKI_EMBED_BASE_URL=https://school.example/v1\n', '');
    expect(() => retargetLlmEnv(unpinned, 'school')).toThrow(/KAKI_EMBED_BASE_URL/);
    expect(retargetLlmEnv(unpinned, 'direct').result.changed).toBe(false);
  });
});

describe('applyLlmUse', () => {
  it('writes the file atomically and leaves nothing behind', () => {
    const envPath = tempEnv(DIRECT_PRIMARY);
    const expected = retargetLlmEnv(DIRECT_PRIMARY, 'school').content;

    const first = applyLlmUse(envPath, 'school');
    expect(first.changed).toBe(true);
    expect(readFileSync(envPath, 'utf8')).toBe(expected);
    expect(readdirSync(join(envPath, '..'))).toEqual(['.env']);

    const second = applyLlmUse(envPath, 'school');
    expect(second.changed).toBe(false);
    expect(readFileSync(envPath, 'utf8')).toBe(expected);
    expect(readdirSync(join(envPath, '..'))).toEqual(['.env']);
  });

  it('leaves the file untouched when it refuses', () => {
    const broken = `${DIRECT_PRIMARY}KAKI_LLM_MODEL=again\n`;
    const envPath = tempEnv(broken);

    expect(() => applyLlmUse(envPath, 'school')).toThrow(/duplicate key/);
    expect(readFileSync(envPath, 'utf8')).toBe(broken);
    expect(readdirSync(join(envPath, '..'))).toEqual(['.env']);
  });
});

describe('formatLlmUseResult and arguments', () => {
  it('shows only the resulting models and hosts, never keys', () => {
    const { result } = retargetLlmEnv(DIRECT_PRIMARY, 'school');
    const output = formatLlmUseResult(result);

    expect(output).toContain('LLM routing set to school.');
    expect(output).toContain('Main: x-test-2 (school.example)');
    expect(output).toContain('Fallback: deepseek-chat (api.deepseek.com)');
    expect(output).toContain('restart the stack for this to take effect');
    expect(output).not.toContain('KAKI_');
    expect(output).not.toContain('direct-key');
    expect(output).not.toContain('school-key');

    const unchanged = formatLlmUseResult(retargetLlmEnv(DIRECT_PRIMARY, 'direct').result);
    expect(unchanged).toContain('nothing changed');
    expect(unchanged).not.toContain('restart the stack');
  });

  it('parses the mode and the optional --env path', () => {
    expect(parseLlmUseArgs(['school'])).toEqual({ mode: 'school' });
    expect(parseLlmUseArgs(['--env', '/tmp/x', 'direct'])).toEqual({ mode: 'direct', envPath: '/tmp/x' });
    expect(parseLlmUseArgs(['--env=/tmp/y', 'school'])).toEqual({ mode: 'school', envPath: '/tmp/y' });
    expect(() => parseLlmUseArgs([])).toThrow(/usage/);
    expect(() => parseLlmUseArgs(['sideways'])).toThrow(/unknown argument/);
    expect(() => parseLlmUseArgs(['--env'])).toThrow(/needs a path/);
  });
});
