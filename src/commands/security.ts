import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { EXIT, UsageError } from '../core/exitCodes.js';
import { loadPolicy } from '../core/policy.js';
import { createDvalinContext } from '../core/context.js';
import { resolveWorkspaceRoot } from '../core/workspace.js';
import { parseDvalinScannerIds, renderDvalinResult } from './dvalin.js';
import {
  DVALIN_SCANNER_IDS,
  dvalinScannerInstallPlan,
  installDvalinScanner,
  listDvalinScanners,
  runDvalinScanSuite,
  type DvalinScannerId,
  type DvalinScanSuiteResult,
} from '../remediation/scannerSuite.js';
import { buildDvalinSarif } from '../remediation/sarifExport.js';
import { runCheckTool } from '../tools/runCheck.js';
import { readSecurityBaseline, writeSecurityBaseline } from '../security/baseline.js';
import {
  loadSecurityConfig,
  resolveSecurityPath,
  writeInitialSecurityConfig,
  type DvalinSecurityConfig,
} from '../security/config.js';
import {
  compareWithBaseline,
  evaluateSecurityGate,
  type SecurityFindingDelta,
  type SecurityGateMode,
  type SecurityScanEnvelope,
  type SecurityThreshold,
} from '../security/contracts.js';
import { applySecuritySuppressions } from '../security/suppressions.js';
import {
  createSecurityWorkflow,
  evaluateWorkflowVerificationGate,
  loadSecurityWorkflow,
  verifySecurityWorkflow,
  type SecurityWorkflow,
  type SecurityCheckEvidence,
} from '../security/workflow.js';

type ScanOptions = {
  config?: string;
  scanners?: string;
  timeout: string;
  limit: string;
  json?: boolean;
  sarif?: string;
  failOn?: string;
  newOnly?: boolean;
  workflow: boolean;
};

type BaselineOptions = { config?: string; scanners?: string; timeout: string; output?: string; json?: boolean };

export type ExecutedSecurityScan = SecurityScanEnvelope & {
  root: string;
  config: DvalinSecurityConfig;
  workflow?: SecurityWorkflow;
  suppressed: number;
  expiredSuppressions: number;
};

export function registerSecurityCommand(program: Command): void {
  const security = program.command('security').description('Deterministic security verification for human- and agent-written code');
  registerSecuritySubcommands(security);
}

/** Shared by `dvalincode security ...` and the focused `dvalin ...` binary. */
export function registerSecuritySubcommands(parent: Command): void {
  parent
    .command('init')
    .description('Create a versioned Dvalin security policy')
    .argument('[path]', 'workspace path', '.')
    .option('--force', 'replace an existing policy')
    .action(async (inputPath: string, options: { force?: boolean }) => {
      const root = await resolveWorkspaceRoot(path.resolve(process.cwd(), inputPath));
      const target = await writeInitialSecurityConfig(root, Boolean(options.force));
      console.log(`Created ${target}`);
      console.log('Next: run `dvalin baseline` once, then use `dvalin scan` as a new-findings gate.');
    });

  parent
    .command('scan')
    .description('Scan code, apply suppressions/baseline policy, and evaluate the gate')
    .argument('[path]', 'workspace path', '.')
    .option('--config <file>', 'security config path (default: dvalin.security.json)')
    .option('--scanners <ids>', `override scanner set: ${DVALIN_SCANNER_IDS.join(', ')}`)
    .option('--timeout <seconds>', 'timeout for each external scanner', '300')
    .option('--limit <count>', 'maximum findings shown in text output', '20')
    .option('--json', 'print the versioned result envelope as JSON')
    .option('--sarif <file>', 'also write SARIF 2.1.0')
    .option('--fail-on <severity>', 'override gate severity: critical, high, medium, low, none')
    .option('--new-only', 'evaluate only findings not present in the baseline')
    .option('--no-workflow', 'do not persist a resumable security workflow')
    .action(async (inputPath: string, options: ScanOptions) => {
      const execution = await executeSecurityScan({
        root: path.resolve(process.cwd(), inputPath),
        configPath: options.config,
        scanners: options.scanners ? parseDvalinScannerIds(options.scanners) : undefined,
        timeoutMs: positiveInteger(options.timeout, '--timeout') * 1000,
        threshold: options.failOn ? parseThreshold(options.failOn) : undefined,
        mode: options.newOnly ? 'new' : undefined,
        saveWorkflow: options.workflow,
      });
      const limit = positiveInteger(options.limit, '--limit');
      if (options.json) {
        console.log(JSON.stringify({
          schemaVersion: execution.schemaVersion,
          scan: execution.scan,
          delta: execution.delta,
          gate: execution.gate,
          workflowId: execution.workflow?.id,
          suppressed: execution.suppressed,
          expiredSuppressions: execution.expiredSuppressions,
        }, null, 2));
      } else {
        console.log(renderSecurityExecution(execution, limit));
      }
      if (options.sarif) await writeSarif(execution.scan, execution.root, options.sarif, !options.json);
      if (!execution.gate.passed) process.exitCode = EXIT.gateNotMet;
    });

  parent
    .command('baseline')
    .description('Record the current accepted findings for a new-findings gate')
    .argument('[path]', 'workspace path', '.')
    .option('--config <file>', 'security config path (default: dvalin.security.json)')
    .option('--scanners <ids>', `override scanner set: ${DVALIN_SCANNER_IDS.join(', ')}`)
    .option('--timeout <seconds>', 'timeout for each external scanner', '300')
    .option('--output <file>', 'override baseline output path')
    .option('--json', 'print baseline metadata as JSON')
    .action(async (inputPath: string, options: BaselineOptions) => {
      const root = await resolveWorkspaceRoot(path.resolve(process.cwd(), inputPath));
      const loaded = await loadSecurityConfig(root, options.config);
      const scanners = options.scanners ? parseDvalinScannerIds(options.scanners) : loaded.config.scanners;
      const raw = await runDvalinScanSuite(root, { scanners, timeoutMs: positiveInteger(options.timeout, '--timeout') * 1000 });
      const suppressed = applySecuritySuppressions(raw, loaded.config.suppressions);
      const output = options.output ?? loaded.config.baseline;
      const written = await writeSecurityBaseline(root, output, suppressed.result);
      const body = { path: written.path, scanId: written.baseline.scanId, findings: written.baseline.findings.length, scanners };
      console.log(options.json ? JSON.stringify(body, null, 2) : `Baseline written to ${written.path} · ${body.findings} accepted finding(s)`);
    });

  parent
    .command('verify')
    .description('Resume a workflow and deterministically re-scan its findings')
    .argument('<workflow-id>', 'security workflow id returned by scan')
    .option('--timeout <seconds>', 'timeout for each external scanner', '300')
    .option('--json', 'print workflow state as JSON')
    .action(async (workflowId: string, options: { timeout: string; json?: boolean }) => {
      const workflow = await loadSecurityWorkflow(workflowId);
      const loaded = await loadSecurityConfig(workflow.root);
      const result = await runDvalinScanSuite(workflow.root, {
        scanners: workflow.scanners,
        timeoutMs: positiveInteger(options.timeout, '--timeout') * 1000,
      });
      const gate = evaluateWorkflowVerificationGate(workflow, result);
      const checks = await runConfiguredChecks(workflow.root, loaded.config.checks);
      const updated = await verifySecurityWorkflow({ workflow, result, gate, checks });
      if (options.json) console.log(JSON.stringify(updated, null, 2));
      else console.log(`Workflow ${updated.id} · ${updated.state} · ${updated.verification?.assurance} · ${updated.latestScan.findings.length} finding(s)`);
      if (updated.state !== 'passed') process.exitCode = EXIT.gateNotMet;
    });

  parent
    .command('doctor')
    .description('Show security policy, baseline, and scanner readiness')
    .argument('[path]', 'workspace path', '.')
    .option('--config <file>', 'security config path')
    .option('--json', 'print diagnostics as JSON')
    .action(async (inputPath: string, options: { config?: string; json?: boolean }) => {
      const root = await resolveWorkspaceRoot(path.resolve(process.cwd(), inputPath));
      const loaded = await loadSecurityConfig(root, options.config);
      const baselinePath = resolveSecurityPath(root, loaded.config.baseline);
      const baselineAvailable = await exists(baselinePath);
      const scanners = await listDvalinScanners();
      const body = { root, configPath: loaded.path, config: loaded.config, baseline: { path: baselinePath, available: baselineAvailable }, scanners };
      if (options.json) console.log(JSON.stringify(body, null, 2));
      else {
        console.log(`Dvalin security doctor · ${root}`);
        console.log(`Policy: ${loaded.path ?? 'defaults (builtin scanner, non-blocking)'}`);
        console.log(`Baseline: ${baselineAvailable ? 'ready' : 'missing'} · ${baselinePath}`);
        for (const scanner of scanners) {
          console.log(`  ${scanner.available ? '✓' : '!'} ${scanner.name}${scanner.available ? '' : ` · ${scanner.installCommand ?? 'install manually'}`}`);
        }
      }
    });

  const scanners = parent.command('scanners').description('Inspect and install optional scanner engines');
  scanners
    .command('list')
    .description('List scanner readiness and install commands')
    .option('--json', 'print scanner descriptors as JSON')
    .action(async (options: { json?: boolean }) => {
      const listed = await listDvalinScanners();
      console.log(options.json ? JSON.stringify(listed, null, 2) : listed.map(scanner =>
        `${scanner.available ? '✓' : '!'} ${scanner.id} · ${scanner.available ? 'ready' : scanner.installCommand ?? 'install manually'}`,
      ).join('\n'));
    });
  scanners
    .command('install')
    .description('Print a fixed install command; execute it only with --yes')
    .argument('<scanner>', `one of ${DVALIN_SCANNER_IDS.join(', ')}`)
    .option('--yes', 'execute the reviewed command under Dvalin policy')
    .action(async (scanner: string, options: { yes?: boolean }) => {
      const id = parseDvalinScannerIds(scanner)[0]!;
      const plan = dvalinScannerInstallPlan(id);
      if (!plan.command) {
        console.log(plan.reason);
        return;
      }
      console.log(`Install plan: ${plan.command}`);
      if (!options.yes) {
        console.log('Review the command, then rerun with --yes to execute it.');
        return;
      }
      await installDvalinScanner(process.cwd(), id);
      console.log(`${id} installation command completed.`);
    });
}

export async function executeSecurityScan(input: {
  root: string;
  configPath?: string;
  scanners?: DvalinScannerId[];
  timeoutMs?: number;
  threshold?: SecurityThreshold;
  mode?: SecurityGateMode;
  saveWorkflow?: boolean;
}): Promise<ExecutedSecurityScan> {
  const root = await resolveWorkspaceRoot(input.root);
  const loaded = await loadSecurityConfig(root, input.configPath);
  const config: DvalinSecurityConfig = {
    ...loaded.config,
    scanners: input.scanners ?? loaded.config.scanners,
    gate: {
      severity: input.threshold ?? loaded.config.gate.severity,
      mode: input.mode ?? loaded.config.gate.mode,
    },
  };
  const raw = await runDvalinScanSuite(root, { scanners: config.scanners, timeoutMs: input.timeoutMs });
  const suppression = applySecuritySuppressions(raw, config.suppressions);
  let delta: SecurityFindingDelta | undefined;
  if (config.gate.mode === 'new') {
    try {
      delta = compareWithBaseline(suppression.result, await readSecurityBaseline(root, config.baseline));
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}. Run \`dvalin baseline\` before using a new-findings gate.`);
    }
  }
  const gate = evaluateSecurityGate({ result: suppression.result, threshold: config.gate.severity, mode: config.gate.mode, delta });
  const workflow = input.saveWorkflow === false ? undefined : await createSecurityWorkflow({ root, result: suppression.result, gate, delta });
  return {
    schemaVersion: 1,
    scan: suppression.result,
    delta,
    gate,
    root,
    config,
    workflow,
    suppressed: suppression.suppressed.length,
    expiredSuppressions: suppression.expired.length,
  };
}

function renderSecurityExecution(execution: ExecutedSecurityScan, limit: number): string {
  const lines = [renderDvalinResult(execution.scan, execution.root, limit)];
  if (execution.delta) {
    lines.push('', `Baseline delta · ${execution.delta.new.length} new · ${execution.delta.existing.length} existing · ${execution.delta.resolved.length} resolved`);
  }
  if (execution.suppressed) lines.push(`Suppressed: ${execution.suppressed}`);
  if (execution.expiredSuppressions) lines.push(`Expired suppressions: ${execution.expiredSuppressions}`);
  lines.push(`Gate: ${execution.gate.passed ? 'PASS' : 'FAIL'} · ${execution.gate.mode} findings · threshold ${execution.gate.threshold}`);
  if (execution.workflow) lines.push(`Workflow: ${execution.workflow.id}`);
  return lines.join('\n');
}

function parseThreshold(value: string): SecurityThreshold {
  if (['critical', 'high', 'medium', 'low', 'none'].includes(value)) return value as SecurityThreshold;
  throw new UsageError('--fail-on must be one of critical, high, medium, low, none.');
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${label} must be a positive integer.`);
  return parsed;
}

async function writeSarif(result: DvalinScanSuiteResult, root: string, file: string, announce: boolean): Promise<void> {
  const target = path.resolve(process.cwd(), file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(buildDvalinSarif(result, root), null, 2)}\n`, 'utf8');
  if (announce) console.log(`SARIF written to ${target}`);
}

async function runConfiguredChecks(
  cwd: string,
  checks: DvalinSecurityConfig['checks'],
): Promise<SecurityCheckEvidence[]> {
  const context = createDvalinContext({ cwd, approvalMode: 'full-auto', policy: loadPolicy(cwd).policy });
  const evidence: SecurityCheckEvidence[] = [];
  for (const kind of checks) {
    try {
      const result = await runCheckTool.run({ kind, args: [], timeoutMs: 120_000 }, context);
      const exitCode = typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : null;
      evidence.push({
        kind,
        command: typeof result.metadata?.command === 'string' ? result.metadata.command : kind,
        exitCode,
        passed: result.metadata?.skipped !== true && exitCode === 0,
      });
    } catch {
      evidence.push({ kind, command: kind, exitCode: null, passed: false });
    }
  }
  return evidence;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
