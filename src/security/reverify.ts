import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AuditSink } from '../audit/log.js';
import { canonicalJSON, sha256 } from '../audit/hash.js';
import { UsageError } from '../core/exitCodes.js';
import { loadPolicy } from '../core/policy.js';
import { assertSafeRef } from '../remediation/diffScope.js';
import { runDvalinScanSuite, type DvalinScannerId, type DvalinScanSuiteResult } from '../remediation/scannerSuite.js';
import { runProjectVerification } from '../remediation/verify.js';
import { loadSecurityConfig, type DvalinSecurityConfig } from './config.js';
import {
  deriveCoverage,
  scannerIdForSource,
  securityProjectId,
  snapshotFinding,
  type SecurityCoverage,
  type SecurityFindingSnapshot,
  type SecurityThreshold,
} from './contracts.js';
import {
  FIX_EXECUTORS,
  buildFixRecord,
  verifyFixRecord,
  type FixExecutor,
  type VerifiedFixRecord,
} from './fixRecord.js';
import type { FixRecordSignatureCheck, TrustedKey } from './fixRecordSignature.js';
import type { SecurityCheckEvidence } from './workflow.js';

const execFileAsync = promisify(execFile);

/**
 * Re-execute a fix record's verification, instead of re-deriving it.
 *
 * Offline re-derivation (`verify-fix`) proves a record is self-consistent. A
 * record is self-consistent by construction, so that is all a forger needs to
 * produce: nothing in it is beyond their reach, the exit codes included. The
 * only way to stop taking the issuer's word for what happened is to make it
 * happen again somewhere the issuer does not control.
 *
 * That is this function. On a runner holding the pull request's checkout, it:
 *
 * - scans the **base** commit, so the targets the record claims to have fixed
 *   must actually have existed — a record cannot claim credit for removing a
 *   finding nobody had;
 * - scans the **head**, so "gone" is observed here, not reported;
 * - runs the project's checks itself, with the checks, gate and scanners taken
 *   from the **base** commit's policy — the change under review does not get to
 *   choose the rules it is judged by (FV-4);
 * - issues a fresh record from those observations alone.
 *
 * The claimed record contributes exactly two things: which targets to look for,
 * and who the executor was. Its exit codes, coverage, verdict and gate are
 * compared against, never used.
 */
export const REVERIFICATION_KIND = 'dvalin-fix-reverification';

export type ReverificationReport = {
  kind: typeof REVERIFICATION_KIND;
  schemaVersion: 1;
  /** The fresh record verified, every claimed target was reproduced on base, and the claim re-derived. */
  ok: boolean;
  reasons: string[];
  /** Differences between what the claim said and what was observed here. Informational. */
  notes: string[];
  claimed: {
    recordHash: string;
    rederived: boolean;
    reasons: string[];
    verified: boolean;
    signatures: FixRecordSignatureCheck[];
  };
  base: { ref: string; commit: string; scanId: string; coverage: SecurityCoverage; policy: 'base' | 'default' };
  head: { commit: string | null; scanId: string; coverage: SecurityCoverage };
  targets: {
    claimed: number;
    reproduced: number;
    /** Claimed targets the base scan did not report, with the engine that should have. */
    unreproduced: SecurityFindingSnapshot[];
  };
  /** The record issued by this run, from this run's observations. */
  record: VerifiedFixRecord;
};

type ScanFn = (
  cwd: string,
  options: NonNullable<Parameters<typeof runDvalinScanSuite>[1]>,
) => ReturnType<typeof runDvalinScanSuite>;

export type ReverifyInput = {
  /** The claimed record, parsed but not trusted. */
  claim: unknown;
  /** The workspace holding the change under review. */
  root: string;
  /** The git revision the change is measured against. */
  base: string;
  /** Replaces the base policy's scanners. The engines that produced the claimed targets are always added. */
  scanners?: DvalinScannerId[];
  /** Replaces the base policy's gate threshold. */
  threshold?: SecurityThreshold;
  timeoutMs?: number;
  /** Checked on the claim and reported; re-execution does not depend on them. */
  trustedKeys?: TrustedKey[];
  /** Dependency seams for deterministic tests. */
  runScan?: ScanFn;
  runChecks?: (input: { cwd: string; kinds: DvalinSecurityConfig['checks']; audit: AuditSink; timeoutMs?: number }) => Promise<SecurityCheckEvidence[]>;
};

export async function reverifyFixRecord(input: ReverifyInput): Promise<ReverificationReport> {
  const claimCheck = verifyFixRecord(input.claim, { trustedKeys: input.trustedKeys });
  if (!claimCheck.record) throw new UsageError('Not a Dvalin fix record, or written by an unsupported schema version.');
  const claim = claimCheck.record;
  assertSafeRef(input.base);

  const root = await realpath(path.resolve(input.root));
  const repoRoot = await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  const subpath = path.relative(repoRoot, root);
  const baseCommit = (await git(root, ['rev-parse', '--verify', '--quiet', `${input.base}^{commit}`]).catch(() => '')).trim();
  if (!baseCommit) throw new UsageError(`Cannot resolve base revision '${input.base}'. Fetch it first (actions/checkout with fetch-depth: 0).`);
  const headCommit = (await git(root, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;

  const scan = input.runScan ?? runDvalinScanSuite;
  const reasons: string[] = [];
  const notes: string[] = [];

  // The base tree is a detached worktree, removed whatever happens. Scanning
  // it in place is what lets "this target existed" be observed rather than
  // taken from the claim.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'dvalin-reverify-'));
  const baseTree = path.join(scratch, 'base');
  let baseResult: DvalinScanSuiteResult;
  let baseConfig: DvalinSecurityConfig;
  let basePolicy: 'base' | 'default';
  let scanners: DvalinScannerId[];
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', '--quiet', baseTree, baseCommit]);
    const baseRoot = path.join(baseTree, subpath);

    // The rules come from base. A pull request that relaxes its own gate, or
    // deletes its own checks, is reviewed under the rules it is trying to change.
    const loaded = await loadSecurityConfig(baseRoot).catch((error: unknown) => {
      throw new UsageError(`The base commit's security policy does not parse: ${error instanceof Error ? error.message : String(error)}`);
    });
    baseConfig = loaded.config;
    basePolicy = loaded.path ? 'base' : 'default';

    const headConfig = await loadSecurityConfig(root).then(value => value.config).catch(() => undefined);
    if (headConfig && canonicalJSON(headConfig) !== canonicalJSON(baseConfig)) {
      notes.push('this change edits dvalin.security.json; it was verified under the base commit\'s policy, not its own');
    }

    // FV-5: at least the engines that produced the targets.
    const targetEngines = claim.before.targets
      .map(target => target.scanner ?? scannerIdForSource(target.source))
      .filter((id): id is DvalinScannerId => Boolean(id));
    scanners = [...new Set([...(input.scanners?.length ? input.scanners : baseConfig.scanners), ...targetEngines])];

    baseResult = await scan(baseRoot, { scanners, timeoutMs: input.timeoutMs });
  } finally {
    await git(repoRoot, ['worktree', 'remove', '--force', baseTree]).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }

  const headResult = await scan(root, { scanners, timeoutMs: input.timeoutMs });

  const baseFindings = baseResult.findings.map(snapshotFinding);
  const headFindings = headResult.findings.map(snapshotFinding);
  const baseCompleted = completedEngines(baseResult);
  const headCompleted = completedEngines(headResult);

  // Which claimed targets existed. A target the base scan did not report is
  // not a repair this change can be credited with; whether that is because the
  // claim invented it or because the engine did not run here, the honest
  // answer is the same — it was not confirmed.
  const baseByTarget = new Map<string, SecurityFindingSnapshot>();
  for (const finding of baseFindings) if (!baseByTarget.has(finding.targetFingerprint)) baseByTarget.set(finding.targetFingerprint, finding);
  const claimedTargetKeys = [...new Set(claim.before.targets.map(target => target.targetFingerprint))];
  const reproduced: SecurityFindingSnapshot[] = [];
  const unreproduced: SecurityFindingSnapshot[] = [];
  for (const key of claimedTargetKeys) {
    const found = baseByTarget.get(key);
    if (found) reproduced.push(found);
    else unreproduced.push(claim.before.targets.find(target => target.targetFingerprint === key)!);
  }
  for (const target of unreproduced) {
    const engine = target.scanner ?? scannerIdForSource(target.source);
    reasons.push(engine && !baseCompleted.has(engine)
      ? `claimed target ${target.ruleId} in ${target.path} could not be confirmed on base: ${engine} did not complete on this runner`
      : `claimed target ${target.ruleId} in ${target.path} does not exist on base ${baseCommit.slice(0, 12)}; the record claims a repair of a finding the base did not have`);
  }

  // FV-22: a target whose engine did not run on head was not looked for, so
  // its absence there is not evidence it was fixed.
  for (const target of reproduced) {
    const engine = target.scanner ?? scannerIdForSource(target.source);
    if (!engine || !headCompleted.has(engine)) {
      reasons.push(`target ${target.ruleId} in ${target.path} is unknown on head: ${engine ?? 'its engine'} did not complete, so its absence is not evidence of a fix`);
    }
  }

  const reproducedKeys = new Set(reproduced.map(target => target.targetFingerprint));
  const threshold = input.threshold
    ?? (basePolicy === 'base' && baseConfig.gate.severity !== 'none' ? baseConfig.gate.severity : 'high');
  if (!input.threshold && threshold !== baseConfig.gate.severity) {
    notes.push(`the base policy sets no blocking gate; regressions were judged at ${threshold}, since a fix verified with nothing able to block it would verify anything`);
  }

  const audit = new AuditSink(`reverify-${randomUUID().slice(0, 8)}`);
  const policy = loadPolicy(root);
  audit.append({
    type: 'run_start',
    task: `security reverify ${claim.recordHash.slice(0, 12)} against ${baseCommit.slice(0, 12)}`,
    mode: 'security-verify',
    provider: 'none',
    model: 'none',
    cwd: root,
    gitHead: headCommit,
    policyHash: policy.hash,
  });
  let checks: SecurityCheckEvidence[];
  let status: 'done' | 'error' = 'done';
  try {
    checks = input.runChecks
      ? await input.runChecks({ cwd: root, kinds: baseConfig.checks, audit, timeoutMs: input.timeoutMs })
      : (await runProjectVerification({ cwd: root, kinds: baseConfig.checks, timeoutMs: input.timeoutMs, audit })).evidence;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    audit.append({ type: 'run_end', status, iterations: 1, warnings: audit.getWarnings() });
  }

  const changes = await changedFiles(root, baseCommit);
  const record = buildFixRecord({
    projectId: securityProjectId(root),
    executor: (FIX_EXECUTORS as readonly string[]).includes(claim.executor) ? claim.executor as FixExecutor : 'unknown',
    before: {
      scanId: baseResult.id,
      completedAt: baseResult.completedAt,
      coverage: deriveCoverage(baseResult),
      targets: reproduced,
    },
    after: {
      scanId: headResult.id,
      completedAt: headResult.completedAt,
      coverage: deriveCoverage(headResult),
      remainingTargets: headFindings.filter(finding => reproducedKeys.has(finding.targetFingerprint)),
    },
    regression: {
      gate: { threshold, mode: baseConfig.gate.mode },
      introduced: introducedSince(baseFindings, headFindings),
    },
    ...(changes ? { changes } : {}),
    checks,
    audit: { runId: audit.runId, headHash: audit.head() },
    policyHash: policy.hash,
  });

  if (!record.verdict.verified) {
    reasons.push(`re-executed verification did not pass (${record.outcome ?? 'not verified'})`);
  }
  if (!claimCheck.ok) {
    reasons.push(...claimCheck.reasons.map(reason => `claimed record: ${reason}`));
  }
  if (claim.verdict.verified !== record.verdict.verified) {
    notes.push(`the claimed record said ${claim.verdict.verified ? 'VERIFIED' : 'NOT VERIFIED'}; re-execution says ${record.verdict.verified ? 'VERIFIED' : 'NOT VERIFIED'}`);
  }
  const claimedCommands = claim.checks.map(check => check.command).sort();
  const observedCommands = checks.map(check => check.command).sort();
  if (canonicalJSON(claimedCommands) !== canonicalJSON(observedCommands)) {
    notes.push(`the claimed record ran [${claimedCommands.join(', ') || 'nothing'}]; the base policy's checks here ran [${observedCommands.join(', ') || 'nothing'}]`);
  }
  if (!claimedTargetKeys.length) {
    notes.push('the claimed record names no targets; this run verifies only that the change introduced nothing and the checks pass');
  }

  return {
    kind: REVERIFICATION_KIND,
    schemaVersion: 1,
    ok: reasons.length === 0,
    reasons,
    notes,
    claimed: {
      recordHash: claim.recordHash,
      rederived: claimCheck.ok,
      reasons: claimCheck.reasons,
      verified: claim.verdict.verified,
      signatures: claimCheck.signatures ?? [],
    },
    base: { ref: input.base, commit: baseCommit, scanId: baseResult.id, coverage: deriveCoverage(baseResult), policy: basePolicy },
    head: { commit: headCommit, scanId: headResult.id, coverage: deriveCoverage(headResult) },
    targets: { claimed: claimedTargetKeys.length, reproduced: reproduced.length, unreproduced },
    record,
  };
}

/**
 * Head findings the base did not have.
 *
 * Exact fingerprints include the line number, so comparing them across two
 * commits reports every pre-existing finding below an inserted line as new.
 * Grouping by target (engine, rule, file) and counting fixes that: a group is
 * only charged with what it grew by, and the charged instances are the ones
 * whose exact fingerprint base did not have. A finding that merely moved is
 * not introduced; a second instance of the same rule in the same file is.
 */
export function introducedSince(base: SecurityFindingSnapshot[], head: SecurityFindingSnapshot[]): SecurityFindingSnapshot[] {
  const baseFingerprints = new Set(base.map(finding => finding.fingerprint));
  const baseCounts = new Map<string, number>();
  for (const finding of base) baseCounts.set(finding.targetFingerprint, (baseCounts.get(finding.targetFingerprint) ?? 0) + 1);
  const groups = new Map<string, SecurityFindingSnapshot[]>();
  for (const finding of head) groups.set(finding.targetFingerprint, [...(groups.get(finding.targetFingerprint) ?? []), finding]);

  const introduced: SecurityFindingSnapshot[] = [];
  for (const [key, group] of groups) {
    const excess = group.length - (baseCounts.get(key) ?? 0);
    if (excess <= 0) continue;
    const unseen = group.filter(finding => !baseFingerprints.has(finding.fingerprint));
    // If fewer instances are unseen than the group grew by, the rest are exact
    // duplicates of base instances; charge them too rather than under-report.
    const seen = group.filter(finding => baseFingerprints.has(finding.fingerprint));
    introduced.push(...[...unseen, ...seen].slice(0, excess));
  }
  return introduced;
}

function completedEngines(result: DvalinScanSuiteResult): Set<DvalinScannerId> {
  return new Set(result.scanners.filter(run => run.status === 'completed').map(run => run.id));
}

async function changedFiles(root: string, baseCommit: string): Promise<{ files: string[]; diffHash: string } | undefined> {
  try {
    const files = (await git(root, ['diff', '--name-only', '--no-color', baseCommit, '--', '.'])).split('\n').map(line => line.trim()).filter(Boolean);
    const diff = await git(root, ['diff', '--no-color', '--no-ext-diff', baseCommit, '--', '.']);
    return { files, diffHash: sha256(diff) };
  } catch {
    return undefined;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
