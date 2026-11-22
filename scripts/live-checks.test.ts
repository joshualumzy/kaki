import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = process.cwd();
const script = join(repo, 'scripts/live-checks.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function run(body: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('bash', ['-c', `source "$1"; shift; ${body}`, 'bash', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'live-checks-'));
  tempDirs.push(dir);
  return dir;
}

function tempEnv(content: string): string {
  const path = join(tempDir(), '.env');
  writeFileSync(path, content);
  return path;
}

const EXAMPLE = '# required: TEST_ONE TEST_TWO TEST_THREE TEST_FOUR\n';
const listed = (text: string): string[] => text.split('\n').filter(Boolean);

describe('required keys in .env.example', () => {
  it('reads only the lowercase "# required:" line', () => {
    const example = tempEnv([
      '# Copy me',
      '# required: TEST_ONE TEST_TWO',
      '# Required: TEST_IGNORED',
      'TEST_ONE=',
      '',
    ].join('\n'));
    expect(listed(run('required_keys "$@"', [example]))).toEqual(['TEST_ONE', 'TEST_TWO']);
  });

  it('has a required line whose keys are all fillable in the repo .env.example', () => {
    const path = join(repo, '.env.example');
    const keys = listed(run('required_keys "$@"', [path]));
    expect(keys.length).toBeGreaterThan(0);
    const text = readFileSync(path, 'utf8');
    for (const key of keys) expect(text).toMatch(new RegExp(`^${key}=`, 'm'));
  });
});

describe('live preflight', () => {
  it('checks the Kaki API directly and through the web proxy', () => {
    const text = readFileSync(join(repo, 'scripts/live-preflight.sh'), 'utf8');
    expect(text).toContain('http://127.0.0.1:${api_port}/health');
    expect(text).toContain('http://localhost:5173/health');
  });
});

describe('missing required keys', () => {
  it('names every key that is missing, empty or only whitespace', () => {
    const env = tempEnv([
      'TEST_ONE=value',
      'TEST_TWO=',
      'TEST_THREE=""',
      "TEST_FOUR=' '",
      '',
    ].join('\n'));
    expect(listed(run('missing_required_keys "$@"', [env, tempEnv(EXAMPLE)]))).toEqual([
      'TEST_TWO', 'TEST_THREE', 'TEST_FOUR',
    ]);
  });

  it('treats a quoted value with surrounding spaces and an inline comment as set', () => {
    const env = tempEnv([
      'TEST_ONE="  key  "',
      'TEST_TWO=value # an inline comment',
      'TEST_THREE=value',
      'TEST_FOUR=value',
      '',
    ].join('\n'));
    expect(run('missing_required_keys "$@"', [env, tempEnv(EXAMPLE)])).toBe('');
  });

  it('counts a key already set in the shell as set', () => {
    const env = tempEnv('TEST_ONE=\nTEST_TWO=\n');
    expect(listed(run('missing_required_keys "$@"', [env, tempEnv('# required: TEST_ONE TEST_TWO\n')], {
      TEST_ONE: 'from-shell',
    }))).toEqual(['TEST_TWO']);
  });

  it('reports every required key when the env file does not exist', () => {
    const missing = join(tempDir(), '.env');
    expect(listed(run('missing_required_keys "$@"', [missing, tempEnv('# required: TEST_ONE TEST_TWO\n')]))).toEqual([
      'TEST_ONE', 'TEST_TWO',
    ]);
  });
});

describe('generated integration settings', () => {
  const keys = [
    'GITEA_URL', 'GITEA_TOKEN', 'GITEA_ORG', 'GITEA_REPO',
    'MATTERMOST_URL', 'MATTERMOST_TOKEN', 'MATTERMOST_TEAM', 'MATTERMOST_CHANNEL',
    'MAILPIT_URL', 'MAILPIT_SMTP_HOST', 'MAILPIT_SMTP_PORT',
    'WIKI_URL', 'WIKI_ADMIN_EMAIL', 'WIKI_ADMIN_PASSWORD', 'CALDAV_URL',
  ];
  const cleanEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...Object.fromEntries(keys.map((key) => [key, ''])), ...extra,
  });

  it('exports what docker/.env generates unless the shell or the root .env already set it', () => {
    const root = tempEnv('GITEA_TOKEN=\nMATTERMOST_TOKEN=from-root\n');
    const generated = tempEnv([
      'GITEA_TOKEN=from-generated',
      'GITEA_ORG=kopitiam',
      'MATTERMOST_TOKEN=from-generated',
      '',
    ].join('\n'));
    const out = run([
      'wire_generated_env "$@"',
      'echo "wired=${WIRED_KEYS[*]}"',
      '[ "$GITEA_TOKEN" = from-generated ] && echo "token-exported"',
      '[ "$GITEA_ORG" = kopitiam ] && echo "org-exported"',
      '[ "$MATTERMOST_TOKEN" = from-shell ] && echo "shell-won"',
      '[ -z "$GITEA_URL" ] && echo "empty-stays-empty"',
    ].join('; '), [root, generated], cleanEnv({ MATTERMOST_TOKEN: 'from-shell' }));
    expect(out).toContain('wired=GITEA_TOKEN GITEA_ORG');
    expect(out).toContain('token-exported');
    expect(out).toContain('org-exported');
    expect(out).toContain('shell-won');
    expect(out).toContain('empty-stays-empty');
  });

  it('leaves a key alone when the root .env already sets it', () => {
    const root = tempEnv('GITEA_TOKEN=from-root\n');
    const generated = tempEnv('GITEA_TOKEN=from-generated\n');
    const out = run('wire_generated_env "$@"; [ -z "$GITEA_TOKEN" ] && echo "root-wins"', [root, generated], cleanEnv());
    expect(out).toContain('root-wins');
  });
});

describe('meeting:reset configuration', () => {
  function resetProject(rootEnv: string, dockerEnv: string): { dir: string; run: (env?: NodeJS.ProcessEnv) => string } {
    const dir = tempDir();
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(join(repo, 'scripts/live-checks.sh'), join(dir, 'scripts/live-checks.sh'));
    copyFileSync(join(repo, 'scripts/meeting-reset.sh'), join(dir, 'scripts/meeting-reset.sh'));
    writeFileSync(join(dir, '.env'), rootEnv);
    mkdirSync(join(dir, 'docker'));
    writeFileSync(join(dir, 'docker/.env'), dockerEnv);
    // Stand in for npx so the wrapper never starts tsx or touches a database; it only reports the
    // POSTGRES_URL the wrapper resolved.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npx'), '#!/usr/bin/env bash\nprintf "%s" "$POSTGRES_URL"\n', { mode: 0o755 });
    return {
      dir,
      run: (env = {}) =>
        execFileSync('bash', ['scripts/meeting-reset.sh'], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, POSTGRES_URL: '', ...env },
        }),
    };
  }

  it('finds POSTGRES_URL in docker/.env when the root .env leaves it empty', () => {
    const project = resetProject('POSTGRES_URL=\n', 'POSTGRES_URL=postgres://from-docker\n');
    expect(project.run()).toBe('postgres://from-docker');
  });

  it('lets a shell POSTGRES_URL win over docker/.env, as npm start does', () => {
    const project = resetProject('POSTGRES_URL=\n', 'POSTGRES_URL=postgres://from-docker\n');
    expect(project.run({ POSTGRES_URL: 'postgres://from-shell' })).toBe('postgres://from-shell');
  });
});

describe('kaki_api_port', () => {
  it('uses PORT from the shell, then .env, then the server default', () => {
    expect(run('kaki_api_port "$@"', [tempEnv('PORT=4123\n')], { PORT: '' })).toBe('4123');
    expect(run('kaki_api_port "$@"', [tempEnv('')], { PORT: '5555' })).toBe('5555');
    expect(run('kaki_api_port "$@"', [join(tempDir(), '.env')], { PORT: '' })).toBe('3001');
  });
});

describe('key_is_set', () => {
  it('checks the shell, then each file in order', () => {
    const root = tempEnv('TEST_ONE=\n');
    const generated = tempEnv('TEST_ONE=generated\n');
    expect(run('key_is_set "$@" && echo set || echo missing', ['TEST_ONE', root, generated])).toBe('set\n');
    expect(run('key_is_set "$@" && echo set || echo missing', ['TEST_ONE', root], { TEST_ONE: 'shell' })).toBe('set\n');
    expect(run('key_is_set "$@" && echo set || echo missing', ['TEST_ONE', root])).toBe('missing\n');
  });
});
