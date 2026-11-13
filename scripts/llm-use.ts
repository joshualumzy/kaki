import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type LlmMode = 'school' | 'direct';

export interface LlmUseResult {
  mode: LlmMode;
  changed: boolean;
  mainModel: string;
  mainHost: string;
  fallbackModel: string;
  fallbackHost: string;
}

const FIELDS = ['BASE_URL', 'API_KEY', 'MODEL', 'REASONING_CONTROL'] as const;
type Field = (typeof FIELDS)[number];
type Slot = 'main' | 'fallback';

const DEFAULT_ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

const MAIN_PREFIX = 'KAKI_LLM_';
const FALLBACK_PREFIX = 'KAKI_LLM_FALLBACK_';

const keyFor = (slot: Slot, field: Field): string =>
  `${slot === 'main' ? MAIN_PREFIX : FALLBACK_PREFIX}${field}`;

const MANAGED = new Map<string, { field: Field; slot: Slot }>();
for (const field of FIELDS) {
  MANAGED.set(keyFor('main', field), { field, slot: 'main' });
  MANAGED.set(keyFor('fallback', field), { field, slot: 'fallback' });
}

interface ManagedLine {
  key: string;
  field: Field;
  slot: Slot;
  prefix: string;
  separator: string;
  value: string;
  comment: string;
  index: number;
}

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

function splitValue(rest: string): { value: string; comment: string } {
  const match = /^(.*?)([ \t]+#.*)?$/.exec(rest)!;
  return { value: match[1] ?? '', comment: match[2] ?? '' };
}

function hostOf(rawValue: string): string | undefined {
  let value = rawValue.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function sameValue(entry: ManagedLine | undefined): string | undefined {
  return entry?.value;
}

/**
 * Swap the main and fallback LLM settings in `.env` text so the DeepSeek endpoint sits in the
 * slot `mode` asks for. Everything else in the file is left alone.
 */
export function retargetLlmEnv(
  original: string,
  mode: LlmMode,
): { content: string; result: LlmUseResult } {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const hadFinalNewline = original.endsWith('\n');
  const lines = original.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();

  const byKey = new Map<string, ManagedLine>();
  const byIndex = new Map<number, ManagedLine>();
  for (const [index, line] of lines.entries()) {
    const match = ASSIGNMENT.exec(line);
    if (match === null) continue;
    const [, prefix, key, separator, rest] = match;
    const info = MANAGED.get(key!);
    if (info === undefined) continue;
    if (byKey.has(key!)) throw new Error(`duplicate key ${key}`);
    const { value, comment } = splitValue(rest!);
    const entry: ManagedLine = {
      key: key!,
      field: info.field,
      slot: info.slot,
      prefix: prefix!,
      separator: separator!,
      value,
      comment,
      index,
    };
    byKey.set(entry.key, entry);
    byIndex.set(index, entry);
  }

  for (const field of ['BASE_URL', 'API_KEY', 'MODEL'] as const) {
    for (const slot of ['main', 'fallback'] as const) {
      const key = keyFor(slot, field);
      const entry = byKey.get(key);
      if (entry === undefined) throw new Error(`required key ${key} is missing`);
      if (entry.value.trim() === '') throw new Error(`required key ${key} is empty`);
    }
  }

  const mainBase = byKey.get(keyFor('main', 'BASE_URL'))!;
  const fallbackBase = byKey.get(keyFor('fallback', 'BASE_URL'))!;
  const mainHost = hostOf(mainBase.value);
  const fallbackHost = hostOf(fallbackBase.value);
  const mainIsDeepseek = mainHost === 'api.deepseek.com';
  const fallbackIsDeepseek = fallbackHost === 'api.deepseek.com';
  if (mainIsDeepseek === fallbackIsDeepseek) {
    throw new Error(
      `cannot tell the school gateway from DeepSeek: ${
        mainIsDeepseek ? 'both slots' : 'neither slot'
      } use api.deepseek.com`,
    );
  }

  const wantedSlot: Slot = mode === 'direct' ? 'main' : 'fallback';
  const deepseekSlot: Slot = mainIsDeepseek ? 'main' : 'fallback';
  // Embeddings default to the fallback gateway (server/src/wingman/knowledge/gateway.ts); a swap would
  // silently send them to the other gateway, which may not serve the embedding model.
  const embedPinned = lines.some((line) => /^\s*(?:export\s+)?KAKI_EMBED_BASE_URL\s*=\s*\S/.test(line));
  if (wantedSlot !== deepseekSlot && !embedPinned) {
    throw new Error('set KAKI_EMBED_BASE_URL and KAKI_EMBED_API_KEY first, so embeddings stay on their gateway when the slots swap');
  }
  if (wantedSlot === deepseekSlot) {
    return {
      content: original,
      result: {
        mode,
        changed: false,
        mainModel: byKey.get(keyFor('main', 'MODEL'))!.value,
        mainHost: mainHost ?? 'unknown host',
        fallbackModel: byKey.get(keyFor('fallback', 'MODEL'))!.value,
        fallbackHost: fallbackHost ?? 'unknown host',
      },
    };
  }

  const newValue = new Map<string, string | undefined>();
  for (const field of FIELDS) {
    const mainEntry = byKey.get(keyFor('main', field));
    const fallbackEntry = byKey.get(keyFor('fallback', field));
    newValue.set(keyFor('main', field), sameValue(fallbackEntry));
    newValue.set(keyFor('fallback', field), sameValue(mainEntry));
  }

  const moved = (source: ManagedLine, key: string): string =>
    `${source.prefix}${key}${source.separator}${source.value}${source.comment}`;
  const insertions = new Map<string, string[]>();
  const insertAfter = (anchor: string, line: string): void => {
    const existing = insertions.get(anchor);
    if (existing === undefined) insertions.set(anchor, [line]);
    else existing.push(line);
  };

  const mainReasoning = byKey.get(keyFor('main', 'REASONING_CONTROL'));
  const fallbackReasoning = byKey.get(keyFor('fallback', 'REASONING_CONTROL'));
  if (mainReasoning !== undefined && fallbackReasoning === undefined) {
    insertAfter(
      keyFor('fallback', 'MODEL'),
      moved(mainReasoning, keyFor('fallback', 'REASONING_CONTROL')),
    );
  }
  if (fallbackReasoning !== undefined && mainReasoning === undefined) {
    insertAfter(
      keyFor('main', 'MODEL'),
      moved(fallbackReasoning, keyFor('main', 'REASONING_CONTROL')),
    );
  }

  const output: string[] = [];
  for (const [index, line] of lines.entries()) {
    const entry = byIndex.get(index);
    if (entry === undefined) {
      output.push(line);
      continue;
    }
    const counterpartKey = keyFor(entry.slot === 'main' ? 'fallback' : 'main', entry.field);
    const counterpart = byKey.get(counterpartKey);
    if (counterpart !== undefined) {
      output.push(`${entry.prefix}${entry.key}${entry.separator}${counterpart.value}${entry.comment}`);
    }
    const extra = insertions.get(entry.key);
    if (extra !== undefined) output.push(...extra);
  }

  const mainBaseValue = newValue.get(keyFor('main', 'BASE_URL'))!;
  const fallbackBaseValue = newValue.get(keyFor('fallback', 'BASE_URL'))!;
  return {
    content: output.join(eol) + (hadFinalNewline ? eol : ''),
    result: {
      mode,
      changed: true,
      mainModel: newValue.get(keyFor('main', 'MODEL'))!,
      mainHost: hostOf(mainBaseValue) ?? 'unknown host',
      fallbackModel: newValue.get(keyFor('fallback', 'MODEL'))!,
      fallbackHost: hostOf(fallbackBaseValue) ?? 'unknown host',
    },
  };
}

function writeAtomically(filePath: string, content: string): void {
  const directory = dirname(filePath);
  const tempPath = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(filePath).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    writeFileSync(tempPath, content, mode === undefined ? undefined : { mode });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // the temp file was never created, or already renamed
    }
    throw error;
  }
}

/** Rewrite the file at `envPath`; leaves it untouched when it is already in the wanted state. */
export function applyLlmUse(envPath: string, mode: LlmMode): LlmUseResult {
  const original = readFileSync(envPath, 'utf8');
  const { content, result } = retargetLlmEnv(original, mode);
  if (result.changed) writeAtomically(envPath, content);
  return result;
}

export function formatLlmUseResult(result: LlmUseResult): string {
  const lines = [
    result.changed
      ? `LLM routing set to ${result.mode}.`
      : `LLM routing already set to ${result.mode}; nothing changed.`,
    `Main: ${result.mainModel} (${result.mainHost})`,
    `Fallback: ${result.fallbackModel} (${result.fallbackHost})`,
  ];
  if (result.changed) lines.push('restart the stack for this to take effect');
  return lines.join('\n');
}

export function parseLlmUseArgs(argv: string[]): { mode: LlmMode; envPath?: string } {
  let mode: LlmMode | undefined;
  let envPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--env') {
      const value = argv[index + 1];
      if (value === undefined || value === '') throw new Error('--env needs a path');
      envPath = value;
      index += 1;
    } else if (arg.startsWith('--env=')) {
      const value = arg.slice('--env='.length);
      if (value === '') throw new Error('--env needs a path');
      envPath = value;
    } else if (arg === 'school' || arg === 'direct') {
      if (mode !== undefined && mode !== arg) throw new Error('choose one of school or direct');
      mode = arg;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (mode === undefined) {
    throw new Error('usage: npm run llm:use -- school|direct [--env <path>]');
  }
  return envPath === undefined ? { mode } : { mode, envPath };
}

function main(): void {
  try {
    const { mode, envPath } = parseLlmUseArgs(process.argv.slice(2));
    const result = applyLlmUse(envPath ?? DEFAULT_ENV_PATH, mode);
    console.log(formatLlmUseResult(result));
  } catch (error) {
    console.error(`llm:use: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
