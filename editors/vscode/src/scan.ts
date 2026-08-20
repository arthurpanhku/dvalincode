/**
 * Runs the Dvalin CLI and parses its JSON. No `vscode` import, so the argument
 * assembly and failure classification are testable directly.
 */

import { spawn } from 'node:child_process';
import type { DvalinScanResult } from './findings.js';

export type ScanRequest = {
  /** Command line for the CLI, e.g. `dvalincode` or `npx -y dvalincode`. */
  command: string;
  cwd: string;
  scanners: string;
  timeoutMs: number;
  /** `workspace` reads everything; `changed` reads only uncommitted lines. Defaults to `workspace`. */
  scope?: 'workspace' | 'changed';
};

export type ScanOutcome =
  | { ok: true; result: DvalinScanResult }
  | { ok: false; reason: 'not-found' | 'timeout' | 'failed'; message: string };

/** Split a configured command string into argv, so `npx -y dvalincode` works. */
export function commandToArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function scanArgs(scanners: string, scope: ScanRequest['scope'] = 'workspace'): string[] {
  // `--fail-on none` keeps the exit code meaningful for real errors only: the
  // editor wants findings as data, not as a failed process.
  const args = ['dvalin', '.', '--scanners', scanners, '--fail-on', 'none', '--json'];
  // On every save, the whole workspace is both slow and mostly irrelevant —
  // what the author wants to see is what they just wrote.
  if (scope === 'changed') args.push('--diff', 'uncommitted');
  return args;
}

/**
 * A scan that reports findings still exits 0 (`--fail-on none`), so a non-zero
 * exit means the CLI itself failed and stdout is not a result to parse.
 */
export function classifyExit(code: number | null, stdout: string, stderr: string): ScanOutcome {
  if (code !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exited with code ${code}`;
    return { ok: false, reason: 'failed', message: detail.slice(0, 400) };
  }
  try {
    return { ok: true, result: JSON.parse(stdout) as DvalinScanResult };
  } catch {
    return { ok: false, reason: 'failed', message: 'Dvalin returned output that was not JSON.' };
  }
}

export function runScan(request: ScanRequest): Promise<ScanOutcome> {
  const argv = commandToArgv(request.command);
  if (!argv.length) {
    return Promise.resolve({ ok: false, reason: 'not-found', message: 'No Dvalin command configured.' });
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: ScanOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const child = spawn(argv[0]!, [...argv.slice(1), ...scanArgs(request.scanners, request.scope)], {
      cwd: request.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: 'timeout', message: `Dvalin did not finish within ${request.timeoutMs}ms.` });
    }, request.timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        err.code === 'ENOENT'
          ? {
              ok: false,
              reason: 'not-found',
              message: `Could not run "${argv[0]}". Set "dvalin.command" — "npx -y dvalincode" needs no install.`,
            }
          : { ok: false, reason: 'failed', message: String(err.message) },
      );
    });

    child.on('close', code => finish(classifyExit(code, stdout, stderr)));
  });
}
