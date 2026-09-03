/**
 * Offline Verified Fix Record adapter for the extension. Kept free of vscode
 * imports so argv construction and non-zero gate outcomes stay unit-testable.
 */

import { spawn } from 'node:child_process';
import { commandToArgv } from './scan.js';

export type FixRecordVerification = {
  schemaVersion?: number;
  path: string;
  ok: boolean;
  reasons: string[];
  record?: {
    recordHash: string;
    assurance: 'scan-only' | 'scan-and-checks';
    executor: string;
    verdict: { verified: boolean; reasons: string[] };
    before: { coverage: { status: 'complete' | 'partial' | 'unknown' } };
    after: { coverage: { status: 'complete' | 'partial' | 'unknown' } };
  };
};

export type FixRecordOutcome =
  | { ok: true; verification: FixRecordVerification }
  | { ok: false; reason: 'not-found' | 'timeout' | 'failed'; message: string };

export function verifyFixArgs(recordPath: string): string[] {
  return ['security', 'verify-fix', recordPath, '--json'];
}

/** A tampered record exits non-zero but still returns a valid JSON verdict. */
export function classifyVerificationExit(code: number | null, stdout: string, stderr: string): FixRecordOutcome {
  try {
    const value = JSON.parse(stdout) as FixRecordVerification;
    if (typeof value.ok === 'boolean' && typeof value.path === 'string' && Array.isArray(value.reasons)) {
      return { ok: true, verification: value };
    }
  } catch {
    // Fall through to the transport/process error below.
  }
  const detail = stderr.trim() || stdout.trim() || `exited with code ${code}`;
  return { ok: false, reason: 'failed', message: detail.slice(0, 400) };
}

export function runFixRecordVerification(input: {
  command: string;
  cwd: string;
  recordPath: string;
  timeoutMs: number;
}): Promise<FixRecordOutcome> {
  const argv = commandToArgv(input.command);
  if (!argv.length) {
    return Promise.resolve({ ok: false, reason: 'not-found', message: 'No Dvalin command configured.' });
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: FixRecordOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const child = spawn(argv[0]!, [...argv.slice(1), ...verifyFixArgs(input.recordPath)], {
      cwd: input.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, reason: 'timeout', message: `Dvalin did not finish within ${input.timeoutMs}ms.` });
    }, input.timeoutMs);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT'
        ? { ok: false, reason: 'not-found', message: `Could not run "${argv[0]}". Configure the Dvalin CLI first.` }
        : { ok: false, reason: 'failed', message: error.message });
    });
    child.on('close', code => finish(classifyVerificationExit(code, stdout, stderr)));
  });
}

export function renderFixRecordVerification(value: FixRecordVerification): string {
  if (!value.record) {
    return `Dvalin fix record: INVALID\n${value.reasons.map(reason => `Reason: ${reason}`).join('\n')}`;
  }
  const integrity = value.ok ? 'integrity verified' : 'integrity failed';
  const verdict = value.record.verdict.verified ? 'VERIFIED' : 'NOT VERIFIED';
  return [
    `Dvalin fix record ${value.record.recordHash.slice(0, 12)} · ${verdict} · ${integrity}`,
    `Assurance: ${value.record.assurance}`,
    `Executor: ${value.record.executor} (recorded, not consulted)`,
    `Coverage: ${value.record.before.coverage.status} → ${value.record.after.coverage.status}`,
    ...value.reasons.map(reason => `Reason: ${reason}`),
  ].join('\n');
}
