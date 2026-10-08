import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AuditSink } from '../audit/log.js';
import { sha256 } from '../audit/hash.js';
import { loadPolicy } from '../core/policy.js';
import {
  deriveCoverage,
  scannerIdForSource,
  securityProjectId,
  snapshotFinding,
  type SecurityFindingSnapshot,
  type SecurityThreshold,
} from '../security/contracts.js';
import { blockingIntroduced, buildFixRecord, type FixExecutor, type VerifiedFixRecord } from '../security/fixRecord.js';
import { introducedSince } from '../security/reverify.js';
import {
  describeSuppressionChange,
  detectSuppressionChanges,
  neutralizeSuppressions,
  type SuppressionChange,
} from '../security/suppressionGuard.js';
import type { SecurityCheckEvidence } from '../security/workflow.js';
import type { ExecutorEvent, RemediationExecutor } from './executor.js';
import { runDvalinScanSuite, type DvalinScannerId, type DvalinScanSuiteResult } from './scannerSuite.js';
import type { RemediationFinding } from './sarif.js';
import { runProjectVerification } from './verify.js';

const execFileAsync = promisify(execFile);

/**
 * The bounded fix loop: an executor edits, Dvalin judges, and only the delta
 * goes back.
 *
 * This replaces the round trip a person does by hand today — push the agent's
 * patch, watch the CI scanner block it again, paste the output back into the
 * agent, rebase, repeat. Here every round is judged where the patch is, with the
 * same engines the gate uses, and the executor hears only what is still wrong.
 *
 * The executor is never the judge. It does not see the scan, does not run the
 * checks that count, and cannot make a finding go away by suppressing it: the
 * suppressions it adds are undone before each scan (`suppressionGuard`) and are
 * themselves an open problem until removed. What it says about its own work is
 * shown to the person, and nothing else reads it.
 *
 * The loop stops when one of these holds, and says which:
 *
 * - `verified`         — every target gone, nothing blocking introduced, every
 *                        check observed passing, no suppression added;
 * - `budget-exhausted` — the round limit was reached first;
 * - `stalled`          — a round changed nothing that was open, or the open
 *                        set stopped shrinking; more rounds would cost without
 *                        converging;
 * - `not-auto-fixable` — every target needs a person (e.g. no fixed version of
 *                        a dependency exists);
 * - `unverifiable`     — the engines that find the targets, or the checks,
 *                        could not run; no edit can fix that.
 */
export type FixLoopOutcome = 'verified' | 'budget-exhausted' | 'stalled' | 'not-auto-fixable' | 'unverifiable';

export type TargetClass = 'dependency' | 'code';

export type FixLoopObservation = {
  scan: DvalinScanSuiteResult;
  checks: SecurityCheckEvidence[];
  checkTails: string[];
  suppressions: SuppressionChange[];
  remaining: SecurityFindingSnapshot[];
  /** Everything the change introduced, unfiltered. */
  introduced: SecurityFindingSnapshot[];
  /** The part of `introduced` at or above the gate. */
  blocking: SecurityFindingSnapshot[];
  /** Engines that produce the targets but did not complete — their targets are unknown, not gone. */
  incompleteEngines: string[];
  hasChanges: boolean;
  /** Stable keys for everything still open; the loop's measure of progress. */
  open: string[];
};

export type FixLoopRound = {
  round: number;
  durationMs: number;
  remaining: number;
  blockingIntroduced: number;
  failedChecks: string[];
  suppressions: number;
  open: number;
  /** Targets closed by the end of this round, out of the loop's targets. */
  fixed: number;
};

export type FixLoopResult = {
  id: string;
  outcome: FixLoopOutcome;
  /** One sentence a person can act on. */
  reason: string;
  rounds: FixLoopRound[];
  /** Targets the loop did not attempt, and why. */
  needsHuman: Array<{ finding: SecurityFindingSnapshot; reason: string }>;
  final?: FixLoopObservation;
  record?: VerifiedFixRecord;
  /** The executor conversation, for a follow-up turn such as publishing. */
  session?: string;
  /** Where the round log was written, when it could be. */
  logPath?: string | null;
};

export type FixLoopInput = {
  /** Where the executor edits: an isolated worktree, or a clean workspace. */
  cwd: string;
  /** The commit the change is measured against. Suppressions are judged relative to it. */
  baseCommit: string;
  /** The scan the loop is answering. */
  before: DvalinScanSuiteResult;
  /** What must close. */
  targets: RemediationFinding[];
  /** Everything the repository already had, so pre-existing findings are not blamed on the change. */
  baseline: RemediationFinding[];
  scanners: DvalinScannerId[];
  threshold: SecurityThreshold;
  maxRounds: number;
  executor: RemediationExecutor;
  executorLabel: FixExecutor;
  provider?: string;
  timeoutMs?: number;
  verifyCommands?: string[];
  /** Context for the first prompt, e.g. which worktree and branch. */
  worktreeContext?: string;
  onRound?: (round: FixLoopRound, observation: FixLoopObservation) => void;
  onExecutorEvent?: (event: ExecutorEvent) => void;
  /** Dependency seams for deterministic tests. */
  runScan?: typeof runDvalinScanSuite;
  runChecks?: (cwd: string) => Promise<{ evidence: SecurityCheckEvidence[]; outputTails: string[] }>;
  logDir?: string;
};

const MANIFEST = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|Pipfile(?:\.lock)?|poetry\.lock|pyproject\.toml|go\.(?:mod|sum)|Cargo\.(?:toml|lock)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|gradle\.lockfile|packages\.lock\.json|[^/]+\.csproj)$/i;

/** Advisory wording that means no release fixes it — an upgrade loop cannot converge. */
const NO_FIX = /no (?:upgrade|patch|fix|remediation)(?: or patch)?(?: path| version)? (?:is )?available|no fixed version|not fixed in any version|fixed version:? none/i;

export function classifyTarget(finding: Pick<RemediationFinding, 'scanner' | 'source' | 'path'>): TargetClass {
  const engine = finding.scanner ?? scannerIdForSource(finding.source);
  if (engine === 'snyk-oss' || engine === 'osv-scanner') return 'dependency';
  return MANIFEST.test(finding.path) ? 'dependency' : 'code';
}

/** Why a target should go to a person instead of the loop, or undefined if the loop should try. */
export function notAutoFixableReason(finding: Pick<RemediationFinding, 'scanner' | 'source' | 'path' | 'message'>): string | undefined {
  if (classifyTarget(finding) === 'dependency' && NO_FIX.test(finding.message)) {
    return 'no fixed version of this dependency is available; it needs a risk decision or a replacement, not an upgrade';
  }
  return undefined;
}

export async function runFixLoop(input: FixLoopInput): Promise<FixLoopResult> {
  const id = `fixloop-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const needsHuman: FixLoopResult['needsHuman'] = [];
  const targets: RemediationFinding[] = [];
  for (const finding of input.targets) {
    const reason = notAutoFixableReason(finding);
    if (reason) needsHuman.push({ finding: snapshotFinding(finding), reason });
    else targets.push(finding);
  }
  // Dependencies first: their fix is close to deterministic, and an upgrade
  // can move code findings too.
  targets.sort((a, b) => Number(classifyTarget(b) === 'dependency') - Number(classifyTarget(a) === 'dependency'));

  const finish = (result: Omit<FixLoopResult, 'id' | 'needsHuman' | 'logPath'>): FixLoopResult => {
    const full: FixLoopResult = { id, needsHuman, ...result };
    full.logPath = writeLoopLog(full, input.logDir);
    return full;
  };

  if (!targets.length) {
    return finish({
      outcome: 'not-auto-fixable',
      reason: `none of the ${input.targets.length} target(s) can be fixed by an edit; they need a person`,
      rounds: [],
    });
  }

  const audit = new AuditSink(id);
  const policy = loadPolicy(input.cwd);
  audit.append({
    type: 'run_start',
    task: `security fix loop over ${targets.length} target(s), at most ${input.maxRounds} round(s)`,
    mode: 'security-verify',
    provider: 'none',
    model: 'none',
    cwd: input.cwd,
    gitHead: input.baseCommit,
    policyHash: policy.hash,
  });

  const targetSnapshots = targets.map(snapshotFinding);
  const baselineSnapshots = input.baseline.map(snapshotFinding);
  const rounds: FixLoopRound[] = [];
  let session: string | undefined;
  let previous: FixLoopObservation | undefined;
  let best = Number.POSITIVE_INFINITY;
  let roundsWithoutImprovement = 0;
  let status: 'done' | 'error' = 'done';
  let result: FixLoopResult | undefined;

  try {
    for (let round = 1; round <= input.maxRounds; round++) {
      const startedAt = Date.now();
      const prompt = round === 1
        ? buildLoopInitialPrompt(targets, input.maxRounds, input.worktreeContext)
        : buildLoopFeedbackPrompt(previous!, { round, maxRounds: input.maxRounds, targets: targetSnapshots });
      const turn = await input.executor.run({ prompt, cwd: input.cwd, resume: session, provider: input.provider }, input.onExecutorEvent);
      session = turn.session ?? session;

      const observation = await observe(input, targetSnapshots, baselineSnapshots, audit);
      const fixed = targetSnapshots.length - observation.remaining.length;
      const summary: FixLoopRound = {
        round,
        durationMs: Date.now() - startedAt,
        remaining: observation.remaining.length,
        blockingIntroduced: observation.blocking.length,
        failedChecks: observation.checks.filter(check => !check.passed).map(check => check.kind),
        suppressions: observation.suppressions.length,
        open: observation.open.length,
        fixed,
      };
      rounds.push(summary);
      input.onRound?.(summary, observation);

      const stop = decide(observation, previous, { round, maxRounds: input.maxRounds, best, roundsWithoutImprovement });
      if (observation.open.length < best) {
        best = observation.open.length;
        roundsWithoutImprovement = 0;
      } else {
        roundsWithoutImprovement += 1;
      }
      previous = observation;
      if (stop) {
        result = finish({
          outcome: stop.outcome,
          reason: stop.reason,
          rounds,
          final: observation,
          record: await issueRecord(input, targetSnapshots, observation, audit),
          session,
        });
        break;
      }
    }
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    audit.append({ type: 'run_end', status, iterations: rounds.length, warnings: audit.getWarnings() });
  }
  // `decide` always stops on the last round, so the loop never falls through.
  return result!;
}

/** The stop rule. Exported because it is the policy, and the policy is what should be tested. */
export function decide(
  observation: FixLoopObservation,
  previous: FixLoopObservation | undefined,
  state: { round: number; maxRounds: number; best: number; roundsWithoutImprovement: number },
): { outcome: FixLoopOutcome; reason: string } | undefined {
  if (!observation.open.length) return { outcome: 'verified', reason: 'every target is gone, nothing blocking was introduced, and every check passed' };
  if (observation.incompleteEngines.length) {
    return {
      outcome: 'unverifiable',
      reason: `${observation.incompleteEngines.join(', ')} did not complete, so the targets it finds cannot be confirmed gone; fix the engine, not the code`,
    };
  }
  if (!observation.checks.length) {
    return { outcome: 'unverifiable', reason: 'no project check could be run, so no repair can be verified; name one with --verify-command' };
  }
  if (previous && sameSet(observation.open, previous.open)) {
    return { outcome: 'stalled', reason: `round ${state.round} left exactly the same ${observation.open.length} problem(s) open as the round before` };
  }
  // Two rounds in a row that do not beat the best so far: the loop is
  // oscillating — fixing one thing and breaking another — not converging.
  if (observation.open.length >= state.best && state.roundsWithoutImprovement >= 1) {
    return { outcome: 'stalled', reason: `the open problems have not dropped below ${state.best} for two rounds` };
  }
  if (state.round >= state.maxRounds) {
    return { outcome: 'budget-exhausted', reason: `${observation.open.length} problem(s) still open after ${state.maxRounds} round(s)` };
  }
  return undefined;
}

async function observe(
  input: FixLoopInput,
  targets: SecurityFindingSnapshot[],
  baseline: SecurityFindingSnapshot[],
  audit: AuditSink,
): Promise<FixLoopObservation> {
  const scan = input.runScan ?? runDvalinScanSuite;
  const suppressions = await detectSuppressionChanges(input.cwd, input.baseCommit);
  let result: DvalinScanSuiteResult;
  if (suppressions.length) {
    const neutral = await neutralizeSuppressions(input.cwd, input.baseCommit, suppressions);
    try {
      result = await scan(neutral.root, { scanners: input.scanners, timeoutMs: input.timeoutMs });
    } finally {
      await neutral.cleanup();
    }
  } else {
    result = await scan(input.cwd, { scanners: input.scanners, timeoutMs: input.timeoutMs });
  }

  const checkRun = input.runChecks
    ? await input.runChecks(input.cwd)
    : await runProjectVerification({
        cwd: input.cwd,
        commands: input.verifyCommands?.length ? input.verifyCommands : undefined,
        timeoutMs: input.timeoutMs,
        audit,
      });

  const current = result.findings.map(snapshotFinding);
  const present = new Set(current.map(finding => finding.targetFingerprint));
  const remaining = targets.filter(target => present.has(target.targetFingerprint));
  const introduced = introducedSince(baseline, current);
  const blocking = blockingIntroduced(introduced, { threshold: input.threshold, mode: 'new' });
  const completed = new Set(result.scanners.filter(run => run.status === 'completed').map(run => run.id as string));
  const incompleteEngines = [...new Set(targets
    .map(target => target.scanner ?? scannerIdForSource(target.source))
    .filter((engine): engine is DvalinScannerId => Boolean(engine))
    .filter(engine => !completed.has(engine)))];
  const hasChanges = Boolean((await git(input.cwd, ['status', '--porcelain'])).trim())
    || Boolean((await git(input.cwd, ['diff', '--name-only', input.baseCommit]).catch(() => '')).trim());

  const open = [
    ...remaining.map(finding => `target:${finding.targetFingerprint}`),
    ...blocking.map(finding => `introduced:${finding.fingerprint}`),
    ...checkRun.evidence.filter(check => !check.passed).map(check => `check:${check.kind}:${check.command}`),
    ...suppressions.map(change => `suppression:${describeSuppressionChange(change)}`),
    ...(checkRun.evidence.length ? [] : ['checks:none']),
    ...incompleteEngines.map(engine => `engine:${engine}`),
  ].sort();

  return {
    scan: result,
    checks: checkRun.evidence,
    checkTails: checkRun.outputTails,
    suppressions,
    remaining,
    introduced,
    blocking,
    incompleteEngines,
    hasChanges,
    open,
  };
}

export function buildLoopInitialPrompt(targets: RemediationFinding[], maxRounds: number, worktreeContext?: string): string {
  const dependencies = targets.filter(target => classifyTarget(target) === 'dependency');
  const code = targets.filter(target => classifyTarget(target) === 'code');
  const list = (findings: RemediationFinding[], offset: number) => findings.map((finding, index) => [
    `${offset + index + 1}. ${finding.source} / ${finding.ruleId}`,
    `   ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`,
    `   ${finding.message}`,
  ].join('\n'));
  return [
    'Fix the security findings below. Dvalin will re-scan and run the project checks itself after you finish, and send back only what is still wrong.',
    `You have at most ${maxRounds} round(s). Stopping early with an honest account is better than a patch that hides a finding.`,
    worktreeContext ?? '',
    '',
    ...(dependencies.length ? ['Vulnerable dependencies:', ...list(dependencies, 0), ''] : []),
    ...(code.length ? ['Code findings:', ...list(code, dependencies.length), ''] : []),
    'Rules:',
    ...(dependencies.length ? [
      '- Dependencies: upgrade to the lowest version that fixes the advisory (the message usually names it) using the project\'s package manager, so the lockfile is regenerated rather than hand-edited. Upgrade the direct dependency that pulls in a vulnerable transitive one. Remove a dependency only if it is unused.',
    ] : []),
    ...(code.length ? [
      '- Code: validate each finding against reachable data flow, then fix the cause with the smallest behavior-preserving change. Rewriting the sink into a form the rule does not match is not a fix.',
    ] : []),
    '- Never add a scanner suppression (.snyk, .semgrepignore, .trivyignore, // deepcode ignore, nosemgrep, nosec, NOSONAR) and never weaken or delete tests. Suppressions are undone before each scan and count against you.',
    '- Run the focused checks for what you changed. Do not commit, push, or open a pull request.',
    'Finish with a short summary: what you changed, and any finding you believe is a false positive and why.',
  ].filter(line => line !== '').join('\n');
}

/** Only the delta: what is still open and why. The executor never sees a verdict it could argue with. */
export function buildLoopFeedbackPrompt(
  observation: FixLoopObservation,
  context: { round: number; maxRounds: number; targets: SecurityFindingSnapshot[] },
): string {
  const where = (finding: SecurityFindingSnapshot) => `${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`;
  const lines = [
    `Round ${context.round} of ${context.maxRounds}. Dvalin re-scanned and ran the checks itself after your last change. ${context.targets.length - observation.remaining.length} of ${context.targets.length} target(s) are now gone — do not regress them. Still open:`,
  ];
  if (observation.remaining.length) {
    lines.push('', `Still present (${observation.remaining.length}):`);
    for (const finding of observation.remaining) lines.push(`- ${finding.source} / ${finding.ruleId} at ${where(finding)}: ${finding.message}`);
  }
  if (observation.blocking.length) {
    lines.push('', `Introduced by your change (${observation.blocking.length}) — these did not exist before:`);
    for (const finding of observation.blocking) lines.push(`- ${finding.source} / ${finding.ruleId} at ${where(finding)}: ${finding.message}`);
  }
  const failed = observation.checks.map((check, index) => ({ check, tail: observation.checkTails[index] ?? '' })).filter(entry => !entry.check.passed);
  if (failed.length) {
    lines.push('', `Checks failing (${failed.length}):`);
    for (const { check, tail } of failed) {
      lines.push(`- ${check.kind}: \`${check.command}\` exited ${check.exitCode ?? 'without an exit code'}`);
      if (tail.trim()) lines.push('```', tail.trim(), '```');
    }
  }
  if (observation.suppressions.length) {
    lines.push('', `Suppressions you added (${observation.suppressions.length}) — they were ignored when scanning and must be removed:`);
    for (const change of observation.suppressions) lines.push(`- ${describeSuppressionChange(change)}`);
  }
  if (!observation.hasChanges) lines.push('', 'Your last turn left no change in the working tree.');
  lines.push('', 'Fix what is listed, then stop. Same rules as before: no suppressions, no weakened tests, no commits.');
  return lines.join('\n');
}

async function issueRecord(
  input: FixLoopInput,
  targets: SecurityFindingSnapshot[],
  observation: FixLoopObservation,
  audit: AuditSink,
): Promise<VerifiedFixRecord> {
  return buildFixRecord({
    projectId: securityProjectId(input.cwd),
    executor: input.executorLabel,
    before: {
      scanId: input.before.id,
      completedAt: input.before.completedAt,
      coverage: deriveCoverage(input.before),
      targets,
    },
    after: {
      scanId: observation.scan.id,
      completedAt: observation.scan.completedAt,
      coverage: deriveCoverage(observation.scan),
      remainingTargets: observation.remaining,
    },
    regression: { gate: { threshold: input.threshold, mode: 'new' }, introduced: observation.introduced },
    ...(await changesSince(input.cwd, input.baseCommit)),
    checks: observation.checks,
    audit: { runId: audit.runId, headHash: audit.head() },
    policyHash: loadPolicy(input.cwd).hash,
  });
}

async function changesSince(cwd: string, baseCommit: string): Promise<{ changes?: { files: string[]; diffHash: string } }> {
  try {
    const tracked = (await git(cwd, ['diff', '--name-only', baseCommit])).split('\n').filter(Boolean);
    const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
    const files = [...new Set([...tracked, ...untracked])].sort();
    if (!files.length) return {};
    const diff = await git(cwd, ['diff', '--no-color', '--no-ext-diff', baseCommit]);
    return { changes: { files, diffHash: sha256(`${diff}\n${untracked.join('\n')}`) } };
  } catch {
    return {};
  }
}

export function defaultFixLoopDir(): string {
  return process.env.DVALINCODE_FIX_LOOP_DIR ?? path.join(os.homedir(), '.dvalincode', 'security', 'fix-loops');
}

/**
 * Every loop is logged — rounds to green, where it stalled, what it was told.
 * That is what tunes the loop, and the only honest evidence of whether it
 * works. A log that cannot be written never fails the loop.
 */
function writeLoopLog(result: FixLoopResult, dir = defaultFixLoopDir()): string | null {
  const target = path.join(dir, `${result.id}.json`);
  const body = {
    kind: 'dvalin-fix-loop',
    schemaVersion: 1,
    id: result.id,
    outcome: result.outcome,
    reason: result.reason,
    rounds: result.rounds,
    needsHuman: result.needsHuman.map(entry => ({ ruleId: entry.finding.ruleId, path: entry.finding.path, reason: entry.reason })),
    recordHash: result.record?.recordHash ?? null,
  };
  try {
    mkdirSync(dir, { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } catch {
    return null;
  }
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
