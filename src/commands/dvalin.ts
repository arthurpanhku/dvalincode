import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import { EXIT, UsageError } from '../core/exitCodes.js';
import { upsertRemediationCases, updateRemediationCase } from '../remediation/cases.js';
import { resolveDiffScope } from '../remediation/diffScope.js';
import {
  EXECUTOR_IDS,
  resolveExecutor,
  type ExecutorEvent,
  type ExecutorId,
  type RemediationExecutor,
} from '../remediation/executor.js';
import { createRemediationWorktree } from '../remediation/worktree.js';
import {
  runDvalinScanSuite,
  type DvalinScannerId,
  type DvalinScanSuiteResult,
} from '../remediation/scannerSuite.js';
import { buildDvalinSarif } from '../remediation/sarifExport.js';
import {
  buildAutomatedFixPrompt,
  buildAutomatedVerificationPrompt,
  buildDraftPrPrompt,
  evaluateVerificationGate,
  extractDraftPrUrl,
} from '../remediation/automate.js';

const execFileAsync = promisify(execFile);

const SCANNER_IDS: DvalinScannerId[] = ['builtin', 'semgrep', 'trivy', 'osv-scanner'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
type FailSeverity = typeof SEVERITIES[number] | 'none';

type DvalinOptions = {
  scanners: string;
  timeout: string;
  limit: string;
  json?: boolean;
  failOn: string;
  fix?: boolean;
  verify?: boolean;
  draftPr?: boolean;
  inPlace?: boolean;
  maxFixes: string;
  provider?: string;
  sarif?: string;
  diff?: string | boolean;
  staged?: boolean;
  executor: string;
};

export function parseDvalinScannerIds(value: string): DvalinScannerId[] {
  const ids = value.split(',').map(item => item.trim()).filter(Boolean);
  const invalid = ids.filter(id => !SCANNER_IDS.includes(id as DvalinScannerId));
  if (invalid.length) {
    throw new UsageError(`Unknown scanner(s): ${invalid.join(', ')}. Choose from ${SCANNER_IDS.join(', ')}.`);
  }
  if (!ids.length) throw new UsageError('Select at least one Dvalin scanner.');
  return [...new Set(ids)] as DvalinScannerId[];
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${label} must be a positive integer.`);
  return parsed;
}

function parseFailSeverity(value: string): FailSeverity {
  if (value === 'none' || SEVERITIES.includes(value as typeof SEVERITIES[number])) return value as FailSeverity;
  throw new UsageError(`--fail-on must be one of none, ${SEVERITIES.join(', ')}.`);
}

function findingSeverity(finding: DvalinScanSuiteResult['findings'][number]): typeof SEVERITIES[number] {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (score >= 9) return 'critical';
  if (finding.severity === 'error' || score >= 7) return 'high';
  if (finding.severity === 'warning' || score >= 4) return 'medium';
  return 'low';
}

export function dvalinFailureThresholdMet(result: DvalinScanSuiteResult, threshold: FailSeverity): boolean {
  if (threshold === 'none') return false;
  const thresholdIndex = SEVERITIES.indexOf(threshold);
  return result.findings.some(finding => SEVERITIES.indexOf(findingSeverity(finding)) <= thresholdIndex);
}

export function renderDvalinResult(result: DvalinScanSuiteResult, root: string, limit = 20): string {
  const lines = [
    result.scope
      ? `Dvalin security scan · ${root} · changed lines vs ${result.scope.ref}`
      : `Dvalin security scan · ${root}`,
    result.scope
      ? `${result.findings.length} findings in ${result.scope.files} changed file(s) · ${result.metrics.rules} rules`
      : `Health ${result.score}/100 (${result.grade}) · ${result.findings.length} findings · ${result.metrics.files} files · ${result.metrics.rules} rules`,
    `Severity critical ${result.metrics.critical} · high ${result.metrics.high} · medium ${result.metrics.medium} · low ${result.metrics.low}`,
    '',
    'Scanners',
    ...result.scanners.map(scanner => {
      const detail = scanner.status === 'missing'
        ? `missing${scanner.installCommand ? ` · install: ${scanner.installCommand}` : ''}`
        : `${scanner.status} · ${scanner.findings} findings · ${scanner.durationMs}ms${scanner.error ? ` · ${scanner.error}` : ''}`;
      return `  ${scanner.name}: ${detail}`;
    }),
  ];

  if (result.findings.length) {
    lines.push('', `Findings (showing ${Math.min(limit, result.findings.length)} of ${result.findings.length})`);
    for (const finding of result.findings.slice(0, limit)) {
      lines.push(`  [${findingSeverity(finding).toUpperCase()}] ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''} · ${finding.ruleId}`);
      lines.push(`    ${finding.message}`);
    }
  } else {
    lines.push('', result.scope
      ? 'No actionable findings on the changed lines. Pre-existing findings elsewhere were not read.'
      : 'No actionable findings. Review scanner coverage before treating this as assurance.');
  }
  if (result.skippedResults) lines.push('', `Note: ${result.skippedResults} result(s) were skipped or truncated.`);
  return lines.join('\n');
}

export function registerDvalinCommand(program: Command): void {
  program
    .command('dvalin')
    .description('Run Dvalin white-box security scanners')
    .argument('[path]', 'workspace path', '.')
    .option('--scanners <ids>', `comma-separated scanners: ${SCANNER_IDS.join(', ')}`, SCANNER_IDS.join(','))
    .option('--timeout <seconds>', 'timeout for each external scanner', '300')
    .option('--limit <count>', 'maximum findings shown in text output', '20')
    .option('--json', 'print the complete scan result as JSON')
    .option('--sarif <file>', 'also write the scan result as SARIF 2.1.0 (for GitHub code scanning)')
    .option('--fail-on <severity>', 'exit non-zero at or above: critical, high, medium, low, none', 'none')
    .option('--fix', 'validate and remediate findings with the configured agent in an isolated worktree')
    .option('--verify', 'after fixing, run tests and an independent security re-scan gate')
    .option('--draft-pr', 'after verification passes, commit, push, and create a draft GitHub PR')
    .option('--in-place', 'apply fixes in the selected workspace instead of an isolated worktree')
    .option('--max-fixes <count>', 'maximum findings sent to one remediation run', '20')
    .option('--provider <name>', 'override the configured model provider for remediation')
    .option('--diff [ref]', 'only report on changed lines; optionally against a revision (e.g. origin/main...HEAD)')
    .option('--staged', 'only report on changed lines in the git index')
    .option('--executor <name>', `who performs a --fix: ${EXECUTOR_IDS.join(', ')}`, 'dvalin')
    .action(async (inputPath: string, options: DvalinOptions) => {
      const root = path.resolve(process.cwd(), inputPath);
      const scanners = parseDvalinScannerIds(options.scanners);
      const timeoutMs = positiveInteger(options.timeout, '--timeout') * 1000;
      const limit = positiveInteger(options.limit, '--limit');
      const maxFixes = positiveInteger(options.maxFixes, '--max-fixes');
      const failOn = parseFailSeverity(options.failOn);
      const shouldFix = Boolean(options.fix || options.verify || options.draftPr);
      const shouldVerify = Boolean(options.verify || options.draftPr);
      if (options.json && shouldFix) throw new UsageError('--json cannot be combined with --fix, --verify, or --draft-pr.');
      if (options.draftPr && options.inPlace) {
        throw new UsageError('--draft-pr requires the default isolated worktree; remove --in-place.');
      }
      if (options.diff && options.staged) throw new UsageError('Use either --diff or --staged, not both.');
      const scoped = Boolean(options.diff || options.staged);
      if (scoped && shouldFix) {
        // A repair may touch lines the diff never named, so verifying it needs
        // to look wider than the scan did. Until that widening exists, refuse
        // rather than verify against the wrong surface.
        throw new UsageError('--diff and --staged scan only; they cannot be combined with --fix, --verify, or --draft-pr.');
      }
      const scope = scoped
        ? await resolveDiffScope(root, {
            staged: Boolean(options.staged),
            ref: typeof options.diff === 'string' ? options.diff : undefined,
          })
        : undefined;
      const executor = shouldFix ? resolveExecutor(parseExecutorId(options.executor)) : undefined;
      if (executor) {
        const unavailable = await executor.unavailableReason();
        if (unavailable) throw new UsageError(`--executor ${executor.id} is unusable: ${unavailable}`);
      }
      const result = await runDvalinScanSuite(root, { scanners, timeoutMs, scope });
      console.log(options.json ? JSON.stringify(result, null, 2) : renderDvalinResult(result, root, limit));
      let thresholdResult = result;
      if (shouldFix && result.findings.length) {
        const findings = result.findings.slice(0, maxFixes);
        if (result.findings.length > findings.length) {
          console.log(`\nRemediation limited to ${findings.length}/${result.findings.length} findings by --max-fixes.`);
        }
        thresholdResult = await runAutomatedRemediation({
          root,
          findings,
          baselineFindings: result.findings,
          scanners,
          timeoutMs,
          inPlace: Boolean(options.inPlace),
          verify: shouldVerify,
          draftPr: Boolean(options.draftPr),
          provider: options.provider,
          executor: executor!,
        });
      } else if (shouldFix) {
        console.log('\nNo findings require remediation.');
      }
      if (options.sarif) {
        // Reflects the final state, so a --fix run uploads what is left rather
        // than the pre-remediation baseline.
        const sarifPath = path.resolve(process.cwd(), options.sarif);
        await mkdir(path.dirname(sarifPath), { recursive: true });
        await writeFile(sarifPath, `${JSON.stringify(buildDvalinSarif(thresholdResult, root), null, 2)}\n`, 'utf8');
        if (!options.json) console.log(`\nSARIF written to ${sarifPath}`);
      }
      if (dvalinFailureThresholdMet(thresholdResult, failOn)) process.exitCode = EXIT.gateNotMet;
    });
}

async function runAutomatedRemediation(input: {
  root: string;
  findings: DvalinScanSuiteResult['findings'];
  baselineFindings: DvalinScanSuiteResult['findings'];
  scanners: DvalinScannerId[];
  timeoutMs: number;
  inPlace: boolean;
  verify: boolean;
  draftPr: boolean;
  provider?: string;
  executor: RemediationExecutor;
}): Promise<DvalinScanSuiteResult> {
  const { executor } = input;
  const cases = await upsertRemediationCases({ cwd: input.root, findings: input.findings });
  let cwd = input.root;
  let worktreeContext: string | undefined;
  if (!input.inPlace) {
    const worktree = await createRemediationWorktree(input.root, input.findings[0]!);
    cwd = worktree.cwd;
    worktreeContext = `Use the prepared isolated worktree ${worktree.cwd} on branch ${worktree.branch}. The original workspace is ${worktree.baseCwd}.`;
    for (const remediationCase of cases) {
      await updateRemediationCase(remediationCase.id, {
        status: 'worktree_ready',
        worktreeCwd: worktree.cwd,
        branch: worktree.branch,
      });
    }
    console.log(`\nIsolated worktree: ${worktree.cwd}\nBranch: ${worktree.branch}`);
  } else {
    const { stdout: initialStatus } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
    if (initialStatus.trim()) throw new Error('--in-place requires a clean git worktree. Commit or stash existing changes first.');
    console.log(`\nApplying remediation in place: ${cwd}`);
  }

  for (const remediationCase of cases) await updateRemediationCase(remediationCase.id, { status: 'fixing' });
  console.log(`\n${executor.name}: validating and fixing findings…`);
  const fixTurn = await executor.run({
    prompt: buildAutomatedFixPrompt(input.findings, worktreeContext),
    cwd,
    provider: input.provider,
  }, renderAutomationEvent);
  console.log(`\n${fixTurn.output}\n`);

  if (!input.verify) {
    console.log('Fix phase complete. Run again with --verify before publishing.');
    return await runDvalinScanSuite(cwd, { scanners: input.scanners, timeoutMs: input.timeoutMs });
  }

  console.log(`${executor.name}: running focused tests and verification…`);
  const verificationTurn = await executor.run({
    prompt: buildAutomatedVerificationPrompt(input.findings, input.scanners),
    resume: fixTurn.session,
    cwd,
    provider: input.provider,
  }, renderAutomationEvent);
  console.log(`\n${verificationTurn.output}\n`);
  if (!executor.attestsEvidence) {
    // Say it out loud rather than let a weaker guarantee pass unremarked: the
    // gate is about to weigh commands the executor says it ran.
    console.log(`Note: ${executor.name} reports its own checks; Dvalin did not attest them. The re-scan below is still independent.`);
  }

  console.log('Dvalin gate: independently re-running scanners…');
  const after = await runDvalinScanSuite(cwd, { scanners: input.scanners, timeoutMs: input.timeoutMs });
  const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
  const gate = evaluateVerificationGate({
    originals: input.findings,
    baseline: input.baselineFindings,
    after,
    agentOutput: verificationTurn.output,
    hasChanges: Boolean(status.trim()),
    checkEvidence: verificationTurn.evidence,
  });
  if (!gate.passed) {
    throw new Error(`Dvalin verification gate failed: ${gate.reasons.join('; ')}`);
  }
  for (const remediationCase of cases) await updateRemediationCase(remediationCase.id, { status: 'verified' });
  console.log(`Verification passed · health ${after.score}/100 (${after.grade}) · ${after.findings.length} remaining finding(s)`);

  if (!input.draftPr) return after;
  console.log(`\n${executor.name}: publishing verified remediation as a draft PR…`);
  const publishTurn = await executor.run({
    prompt: buildDraftPrPrompt(input.findings),
    resume: verificationTurn.session,
    cwd,
    provider: input.provider,
  }, renderAutomationEvent);
  console.log(`\n${publishTurn.output}\n`);
  const url = extractDraftPrUrl(publishTurn.output);
  if (!url) throw new Error('Draft PR publication did not return a GitHub pull request URL.');
  console.log(`Draft PR: ${url}`);
  return after;
}

function parseExecutorId(value: string): ExecutorId {
  if ((EXECUTOR_IDS as string[]).includes(value)) return value as ExecutorId;
  throw new UsageError(`Unknown --executor '${value}'. Expected one of: ${EXECUTOR_IDS.join(', ')}.`);
}

function renderAutomationEvent(event: ExecutorEvent): void {
  if (event.type === 'tool_call') console.log(`  → ${event.name}`);
  if (event.type === 'tool_error') console.log(`  ✗ ${event.name}: ${event.error}`);
}
