import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'dev', '-w', '@kaki/server'], {
    stdio: 'inherit',
    env: { ...process.env, KAKI_DEV_ROUTES: process.env.KAKI_DEV_ROUTES ?? '1' },
  }),
  spawn(npm, ['run', 'dev', '-w', '@kaki/web'], { stdio: 'inherit' }),
];

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('kaki dev: failed to start a workspace', error);
    shutdown('SIGTERM');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`kaki dev: a workspace stopped (${signal ?? code}); shutting the other down`);
    shutdown('SIGTERM');
    process.exitCode = code ?? 1;
  });
}
