import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const authOn = process.env.KAKI_AUTH === '1';
// Dev routes are a local tool only; with sign-in on the server refuses to start with them enabled.
// The local trusted demo binds every interface, which an open server may only do with this opt-in.
const devEnv = {
  ...process.env,
  KAKI_DEV_ROUTES: process.env.KAKI_DEV_ROUTES ?? (authOn ? '0' : '1'),
  ...(authOn ? {} : { KAKI_ALLOW_OPEN: process.env.KAKI_ALLOW_OPEN ?? '1' }),
};
const children = [
  spawn(npm, ['run', 'dev', '-w', '@kaki/server'], {
    stdio: 'inherit',
    env: devEnv,
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
