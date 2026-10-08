import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectEvasion, toRecordEvasion, type EvasionSignal } from '../remediation/evasion.js';
import { runDvalinScanSuite, type DvalinScannerId, type DvalinScanSuiteResult } from '../remediation/scannerSuite.js';
import type { SecurityFindingSnapshot } from './contracts.js';
import type { FixRecordEvasion } from './fixRecord.js';
import { detectSuppressionChanges, neutralizeSuppressions, type SuppressionChange } from './suppressionGuard.js';

const execFileAsync = promisify(execFile);

/**
 * The verifying scan every surface uses, so "verified" means one thing.
 *
 * The fix loop and CI `reverify` already judged a change with the
 * suppressions it added undone and its evasions recorded. `dvalin verify`,
 * the MCP `dvalin_verify_findings` tool and single-round `--fix --verify` did
 * not, so an agent adding a `.snyk` entry got "verified" from them and not from
 * the loop. They all scan through here now.
 *
 * Needs git to know what the change is. Without it — no repository, no base —
 * the scan is plain and `evasion` is `undefined`, which tells the record
 * builder to issue v2: a record that says it did not evaluate evasion, rather
 * than one that fails for a reason the user cannot act on.
 */
export type GuardedScan = {
  result: DvalinScanSuiteResult;
  suppressions: SuppressionChange[];
  signals: EvasionSignal[];
  /** For the record: `undefined` when the change could not be determined (no git). */
  evasion: FixRecordEvasion[] | undefined;
  base?: string;
};

export async function guardedScan(input: {
  root: string;
  /** The commit the change is measured against; `HEAD` when the work is uncommitted. */
  baseCommit?: string;
  scanners: DvalinScannerId[];
  timeoutMs?: number;
  targets: SecurityFindingSnapshot[];
  exempt?: string[];
  runScan?: (cwd: string, options: NonNullable<Parameters<typeof runDvalinScanSuite>[1]>) => ReturnType<typeof runDvalinScanSuite>;
}): Promise<GuardedScan> {
  const scan = input.runScan ?? runDvalinScanSuite;
  const base = await resolveBase(input.root, input.baseCommit);
  if (!base) {
    return { result: await scan(input.root, { scanners: input.scanners, timeoutMs: input.timeoutMs }), suppressions: [], signals: [], evasion: undefined };
  }
  const suppressions = await detectSuppressionChanges(input.root, base);
  let result: DvalinScanSuiteResult;
  if (suppressions.length) {
    const neutral = await neutralizeSuppressions(input.root, base, suppressions);
    try {
      result = await scan(neutral.root, { scanners: input.scanners, timeoutMs: input.timeoutMs });
    } finally {
      await neutral.cleanup();
    }
  } else {
    result = await scan(input.root, { scanners: input.scanners, timeoutMs: input.timeoutMs });
  }
  const signals = await detectEvasion(input.root, base, input.targets, { exempt: input.exempt });
  return { result, suppressions, signals, evasion: signals.map(toRecordEvasion), base };
}

/** The current HEAD, for a workflow about to be changed; undefined outside a repository. */
export async function currentHead(root: string): Promise<string | undefined> {
  return resolveBase(root, 'HEAD');
}

async function resolveBase(root: string, ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
