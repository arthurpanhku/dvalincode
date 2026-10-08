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
import {
  blockingIntroduced,
  buildFixRecord,
  type FixExecutor,
  type FixRecordReproduction,
  type VerifiedFixRecord,
} from '../security/fixRecord.js';
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
import { describeEvasion, detectEvasion, evasionKey, isTestPath, type EvasionSignal } from './evasion.js';
import { classifyReproExit, hashFiles, reproCommand, type ReproRunner } from './reproduce.js';

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
 *                        could not run; no edit can fix that;
 * - `not-reproduced`   — with reproduce-then-fix, no test written for the code
 *                        findings failed on the vulnerable code. The finding may
 *                        be a false positive or unreachable: a person triages it,
 *                        and no fix is attempted on a vulnerability nobody could
 *                        demonstrate.
 *
 * With reproduce-then-fix (`reproduce`), code findings get a phase before any
 * fix: the executor writes tests only, Dvalin requires them to fail on the
 * vulnerable code, hashes them, and from then on requires them to pass
 * unchanged. See `reproduce.ts`. Evasion signals (`evasion.ts`) are open
 * problems in every fix round.
 */
export type FixLoopOutcome = 'verified' | 'budget-exhausted' | 'stalled' | 'not-auto-fixable' | 'unverifiable' | 'not-reproduced';

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
  /** Ways the change may have hidden a finding instead of fixing it. */
  evasion: EvasionSignal[];
  /** Reproduction tests that changed or vanished since they were shown to fail. */
  reproTampered: string[];
  hasChanges: boolean;
  /** Stable keys for everything still open; the loop's measure of progress. */
  open: string[];
};

export type FixLoopRound = {
  /** `reproduce` rounds write tests only; `fix` rounds are counted against `maxRounds`. */
  phase: 'reproduce' | 'fix';
  round: number;
  durationMs: number;
  remaining: number;
  blockingIntroduced: number;
  failedChecks: string[];
  suppressions: number;
  evasion: number;
  open: number;
  /** Targets closed by the end of this round, out of the loop's targets. */
  fixed: number;
  /** Reproduce rounds only: what still stood between the tests and a demonstrated failure. */
  problems?: string[];
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
  /** Present when reproduce-then-fix ran. */
  reproduction?: FixRecordReproduction;
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
  /**
   * Reproduce-then-fix for code findings. Absent: code findings are fixed
   * without a reproduction. Dependency findings never need one.
   */
  reproduce?: { runner: ReproRunner; rounds: number };
  onRound?: (round: FixLoopRound, observation: FixLoopObservation) => void;
  onReproduceRound?: (round: FixLoopRound) => void;
  onExecutorEvent?: (event: ExecutorEvent) => void;
  /** Dependency seams for deterministic tests. */
  runScan?: typeof runDvalinScanSuite;
  runChecks?: (cwd: string) => Promise<{ evidence: SecurityCheckEvidence[]; outputTails: string[] }>;
  runRepro?: (cwd: string, command: string) => Promise<{ exitCode: number | null; tail: string }>;
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
  let repro: ReproState | undefined;

  try {
    const codeTargets = targets.filter(target => classifyTarget(target) === 'code');
    if (input.reproduce && codeTargets.length) {
      let problems: string[] = [];
      for (let attempt = 1; attempt <= input.reproduce.rounds; attempt++) {
        const startedAt = Date.now();
        const prompt = attempt === 1
          ? buildReproducePrompt(codeTargets, input.reproduce.rounds, input.worktreeContext)
          : buildReproduceFeedbackPrompt(problems, { attempt, rounds: input.reproduce.rounds });
        const turn = await input.executor.run({ prompt, cwd: input.cwd, resume: session, provider: input.provider }, input.onExecutorEvent);
        session = turn.session ?? session;
        const attemptResult = await attemptReproduction(input, input.reproduce.runner, audit);
        problems = attemptResult.problems;
        const summary: FixLoopRound = {
          phase: 'reproduce',
          round: attempt,
          durationMs: Date.now() - startedAt,
          remaining: targetSnapshots.length,
          blockingIntroduced: 0,
          failedChecks: [],
          suppressions: 0,
          evasion: 0,
          open: problems.length,
          fixed: 0,
          problems,
        };
        rounds.push(summary);
        input.onReproduceRound?.(summary);
        if (!problems.length) {
          repro = attemptResult.state;
          break;
        }
      }
      if (!repro) {
        return finish({
          outcome: 'not-reproduced',
          reason: `after ${input.reproduce.rounds} attempt(s) no test failed on the vulnerable code (${problems.join('; ')}); the finding may be a false positive or unreachable — a person should triage it before anything is fixed`,
          rounds,
          session,
        });
      }
    }

    for (let round = 1; round <= input.maxRounds; round++) {
      const startedAt = Date.now();
      const prompt = round === 1
        ? buildLoopInitialPrompt(targets, input.maxRounds, input.worktreeContext, repro?.tests.map(test => test.path))
        : buildLoopFeedbackPrompt(previous!, { round, maxRounds: input.maxRounds, targets: targetSnapshots });
      const turn = await input.executor.run({ prompt, cwd: input.cwd, resume: session, provider: input.provider }, input.onExecutorEvent);
      session = turn.session ?? session;

      const observation = await observe(input, targetSnapshots, baselineSnapshots, audit, repro);
      const fixed = targetSnapshots.length - observation.remaining.length;
      const summary: FixLoopRound = {
        phase: 'fix',
        round,
        durationMs: Date.now() - startedAt,
        remaining: observation.remaining.length,
        blockingIntroduced: observation.blocking.length,
        failedChecks: observation.checks.filter(check => !check.passed).map(check => check.kind),
        suppressions: observation.suppressions.length,
        evasion: observation.evasion.length,
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
        const reproduction = repro ? reproductionEvidence(repro, observation) : undefined;
        result = finish({
          outcome: stop.outcome,
          reason: stop.reason,
          rounds,
          final: observation,
          record: await issueRecord(input, targetSnapshots, observation, audit, reproduction),
          ...(reproduction ? { reproduction } : {}),
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
  repro?: ReproState,
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

  const projectChecks = input.runChecks
    ? await input.runChecks(input.cwd)
    : await runProjectVerification({
        cwd: input.cwd,
        commands: input.verifyCommands?.length ? input.verifyCommands : undefined,
        timeoutMs: input.timeoutMs,
        audit,
      });
  const checkRun = { evidence: [...projectChecks.evidence], outputTails: [...projectChecks.outputTails] };

  // The reproduction tests, run as a check that must pass like any other, and
  // compared byte-for-byte with what was shown to fail.
  const reproTampered: string[] = [];
  if (repro) {
    const now = await hashFiles(input.cwd, repro.tests.map(test => test.path));
    for (const [index, test] of now.entries()) {
      if (test.sha256 !== repro.tests[index]!.sha256) reproTampered.push(test.path);
    }
    const run = await runRepro(input, repro.command, audit);
    checkRun.evidence.push({ kind: 'reproduce', command: repro.command, exitCode: run.exitCode, passed: classifyReproExit(repro.runner, run.exitCode, run.tail) === 'passed' });
    checkRun.outputTails.push(run.tail);
  }
  const evasion = await detectEvasion(input.cwd, input.baseCommit, targets, { exempt: repro?.tests.map(test => test.path) });

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
    ...evasion.map(evasionKey),
    ...reproTampered.map(file => `reproduction-changed:${file}`),
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
    evasion,
    reproTampered,
    hasChanges,
    open,
  };
}

export function buildLoopInitialPrompt(targets: RemediationFinding[], maxRounds: number, worktreeContext?: string, reproTests?: string[]): string {
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
    ...(reproTests?.length ? [
      `These tests reproduce the code findings and fail on the current code: ${reproTests.join(', ')}. Make them pass by fixing the code. Do not edit them — they are compared byte-for-byte.`,
      '',
    ] : []),
    'Rules:',
    ...(dependencies.length ? [
      '- Dependencies: upgrade to the lowest version that fixes the advisory (the message usually names it) using the project\'s package manager, so the lockfile is regenerated rather than hand-edited. Upgrade the direct dependency that pulls in a vulnerable transitive one. Remove a dependency only if it is unused.',
    ] : []),
    ...(code.length ? [
      '- Code: validate each finding against reachable data flow, then fix the cause with the smallest behavior-preserving change. Rewriting the sink into a form the rule does not match is not a fix.',
    ] : []),
    '- Never add a scanner suppression (.snyk, .semgrepignore, .trivyignore, // deepcode ignore, nosemgrep, nosec, NOSONAR) and never weaken or delete tests. Suppressions are undone before each scan and count against you.',
    '- Do not delete the vulnerable file or feature to make a finding disappear, and do not move the dangerous call into a sibling (eval → new Function, exec → spawn with shell: true). Both are detected and not accepted.',
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
  if (observation.evasion.length) {
    lines.push('', `Not accepted as fixes (${observation.evasion.length}) — each hides a finding rather than removing it:`);
    for (const signal of observation.evasion) lines.push(`- ${describeEvasion(signal)}`);
  }
  if (observation.reproTampered.length) {
    lines.push('', `Reproduction tests you changed (${observation.reproTampered.length}) — restore them exactly; the fix has to make them pass as they were written:`);
    for (const file of observation.reproTampered) lines.push(`- ${file}`);
  }
  if (!observation.hasChanges) lines.push('', 'Your last turn left no change in the working tree.');
  lines.push('', 'Fix what is listed, then stop. Same rules as before: no suppressions, no weakened tests, no commits.');
  return lines.join('\n');
}

type ReproState = {
  runner: ReproRunner;
  command: string;
  tests: Array<{ path: string; sha256: string | null }>;
  before: { exitCode: number | null };
};

/**
 * One reproduction attempt, judged here: tests only, at least one, and they
 * fail on the code as it is — by a failing test, not a broken runner.
 */
async function attemptReproduction(
  input: FixLoopInput,
  runner: ReproRunner,
  audit: AuditSink,
): Promise<{ problems: string[]; state?: ReproState }> {
  const tracked = (await git(input.cwd, ['diff', '--name-only', '--relative', input.baseCommit])).split('\n').filter(Boolean);
  const untracked = (await git(input.cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  const deleted = new Set((await git(input.cwd, ['diff', '--name-only', '--diff-filter=D', '--relative', input.baseCommit])).split('\n').filter(Boolean));
  const changed = [...new Set([...tracked, ...untracked])].filter(file => !deleted.has(file)).sort();
  const tests = changed.filter(isTestPath);
  const nonTest = [...changed.filter(file => !isTestPath(file)), ...deleted];

  const problems: string[] = [];
  if (nonTest.length) problems.push(`only tests may change in this phase, but these did: ${nonTest.join(', ')} — revert them`);
  if (!tests.length) {
    problems.push('no test file was added or changed');
    return { problems };
  }
  const command = reproCommand(runner.template, tests);
  const run = await runRepro(input, command, audit);
  const outcome = classifyReproExit(runner, run.exitCode, run.tail);
  if (outcome === 'passed') problems.push(`\`${command}\` passed on the vulnerable code, so the tests do not reproduce the finding`);
  if (outcome === 'error') problems.push(`\`${command}\` did not reach a failing test (exit ${run.exitCode ?? 'none'}): ${run.tail.split('\n').slice(-5).join(' ').slice(0, 400)}`);
  if (problems.length) return { problems };
  return {
    problems,
    state: { runner, command, tests: await hashFiles(input.cwd, tests), before: { exitCode: run.exitCode } },
  };
}

async function runRepro(input: FixLoopInput, command: string, audit: AuditSink): Promise<{ exitCode: number | null; tail: string }> {
  if (input.runRepro) return input.runRepro(input.cwd, command);
  const run = await runProjectVerification({ cwd: input.cwd, commands: [command], timeoutMs: input.timeoutMs, audit });
  return { exitCode: run.evidence[0]?.exitCode ?? null, tail: run.outputTails[0] ?? '' };
}

function reproductionEvidence(repro: ReproState, observation: FixLoopObservation): FixRecordReproduction {
  const after = observation.checks.find(check => check.kind === 'reproduce');
  const flipped = Boolean(after?.passed) && !observation.reproTampered.length;
  return {
    status: flipped ? 'reproduced' : 'failed-before-fix',
    command: repro.command,
    tests: repro.tests,
    before: repro.before,
    ...(after ? { after: { exitCode: after.exitCode } } : {}),
  };
}

export function buildReproducePrompt(targets: RemediationFinding[], rounds: number, worktreeContext?: string): string {
  return [
    'Before anything is fixed, demonstrate the code findings below with tests. Do NOT fix them yet.',
    worktreeContext ?? '',
    '',
    ...targets.map((finding, index) => [
      `${index + 1}. ${finding.source} / ${finding.ruleId}`,
      `   ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`,
      `   ${finding.message}`,
    ].join('\n')),
    '',
    'Write focused security regression tests in the project\'s existing test framework and test directory:',
    '- Drive the vulnerable entry point with a malicious input (an injection payload, a traversal path, a script tag) and assert the safe behavior — the input is rejected, escaped, or not executed.',
    '- The tests must FAIL on the current code because the vulnerability is real, not because something is missing: do not import functions that do not exist yet.',
    '- Change test files only. Dvalin will run just these tests on the current code and require them to fail.',
    `- You have ${rounds} attempt(s). If a finding cannot be demonstrated — unreachable code, a false positive — say so and why; that is a valid answer.`,
    'Finish with the test file paths and, per finding, the payload you used.',
  ].filter(line => line !== '').join('\n');
}

export function buildReproduceFeedbackPrompt(problems: string[], context: { attempt: number; rounds: number }): string {
  return [
    `Reproduction attempt ${context.attempt} of ${context.rounds}. Dvalin ran your tests on the current code. Not yet a reproduction:`,
    ...problems.map(problem => `- ${problem}`),
    '',
    'Adjust the tests (tests only, no fixes) so they fail on the current code because of the vulnerability.',
  ].join('\n');
}

async function issueRecord(
  input: FixLoopInput,
  targets: SecurityFindingSnapshot[],
  observation: FixLoopObservation,
  audit: AuditSink,
  reproduction?: FixRecordReproduction,
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
    ...(reproduction ? { reproduction } : {}),
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
    reproduction: result.reproduction?.status ?? null,
    evasion: (result.final?.evasion ?? []).map(describeEvasion),
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
