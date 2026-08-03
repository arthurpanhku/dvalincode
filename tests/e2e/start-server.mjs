import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const backendPort = '3921';
const frontendPort = '5921';
const home = path.join(root, '.tmp', 'e2e-home');

// Start from an empty home so the suite exercises a genuine first run instead of
// whatever state the previous run — or the developer's own ~/.dvalincode — left
// behind. Sessions and policy have their own env overrides and need them set
// explicitly; DVALINCODE_HOME alone does not redirect either one.
rmSync(home, { recursive: true, force: true });
mkdirSync(home, { recursive: true });

const env = {
  ...process.env,
  DVALINCODE_API_PORT: backendPort,
  DVALINCODE_HOME: home,
  DVALINCODE_SESSIONS_DIR: path.join(home, 'sessions'),
  DVALINCODE_POLICY_FILE: path.join(home, 'policy.json'),
  DVALINCODE_WORKSPACE_ROOTS: root,
  VITE_AUTO_OPEN: '0',
};

const children = [
  spawn('npm', ['run', 'server:dev'], {
    cwd: root,
    env: { ...env, PORT: backendPort },
    stdio: 'inherit',
  }),
  spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', frontendPort, '--strictPort'], {
    cwd: path.join(root, 'web'),
    env,
    stdio: 'inherit',
  }),
];

function shutdown(signal = 'SIGTERM') {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
  process.exit(0);
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
  process.exit(0);
});

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      shutdown();
      process.exit(code);
    }
    if (signal) {
      shutdown(signal);
      process.exit(0);
    }
  });
}
