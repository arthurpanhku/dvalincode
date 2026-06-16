import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const backendPort = '3921';
const frontendPort = '5921';
const env = {
  ...process.env,
  DVALINCODE_API_PORT: backendPort,
  DVALINCODE_HOME: path.join(root, '.tmp', 'e2e-home'),
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
