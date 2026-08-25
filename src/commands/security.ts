import { access, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { EXIT, UsageError } from '../core/exitCodes.js';
import { FIX_EXECUTORS, renderFixRecord, verifyFixRecord, type FixExecutor } from '../security/fixRecord.js';
import { runWorkflowVerification } from '../security/verifyRun.js';
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
import { parseSarifForRemediation, type RemediationFinding } from '../remediation/sarif.js';
import { upsertRemediationCases, type RemediationCase } from '../remediation/cases.js';
import { readSecurityBaseline, writeSecurityBaseline } from '../security/baseline.js';
import {
  loadSecurityConfig,
  resolveSecurityPath,
  writeInitialSecurityConfig,
  type DvalinSecurityConfig,
} from '../security/config.js';
import {
  SECURITY_SCHEMA_VERSION,
  compareWithBaseline,
  deriveCoverage,
  evaluateSecurityGate,
  type SecurityCoverage,
  type SecurityFindingDelta,
  type SecurityGateMode,
  type SecurityScanEnvelope,
  type SecurityThreshold,
} from '../security/contracts.js';
import { applySecuritySuppressions } from '../security/suppressions.js';
import {
  createSecurityWorkflow,
  loadSecurityWorkflow,
  type SecurityWorkflow,
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
type VerifyOptions = { timeout: string; record?: string; executor?: string; json?: boolean };
type ImportOptions = { json?: boolean; persist: boolean };

export const MAX_SECURITY_SARIF_IMPORT_BYTES = 64 * 1024 * 1024;

export type SecuritySarifImport = {
  schemaVersion: 1;
  kind: 'dvalin-security-import';
  root: string;
  reportPath: string;
  source: string;
  totalResults: number;
  skippedResults: number;
  findings: RemediationFinding[];
  cases: RemediationCase[];
  persisted: boolean;
};

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
          coverage: execution.coverage,
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
    .command('import')
    .description('Import a SARIF handoff into Dvalin remediation cases')
    .argument('<report>', 'SARIF 2.1 report exported by Codex Security or another compatible scanner')
    .argument('[path]', 'workspace path used to resolve finding locations', '.')
    .option('--json', 'print the versioned import envelope as JSON')
    .option('--no-persist', 'parse the report without creating remediation cases')
    .action(async (report: string, inputPath: string, options: ImportOptions) => {
      const imported = await executeSecuritySarifImport({
        root: path.resolve(process.cwd(), inputPath),
        reportPath: path.resolve(process.cwd(), report),
        persist: options.persist,
      });
      if (options.json) {
        console.log(JSON.stringify(imported, null, 2));
      } else {
        console.log(`Imported ${imported.findings.length}/${imported.totalResults} finding(s) from ${imported.source}.`);
        if (imported.skippedResults) console.log(`Skipped ${imported.skippedResults} result(s) without a safe workspace location.`);
        console.log(imported.persisted
          ? `Created or updated ${imported.cases.length} remediation case(s).`
          : 'Persistence disabled; no remediation cases were changed.');
        console.log('Next: review the external evidence, then run `dvalin scan .` as the independent release gate.');
      }
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
    .description('Resume a workflow, re-scan it, run the project checks, and issue a fix record')
    .argument('<workflow-id>', 'security workflow id returned by scan')
    .option('--timeout <seconds>', 'timeout for each external scanner', '300')
    .option('--record <file>', 'write the Verified Fix Record as JSON')
    .option('--executor <name>', `who performed the repair, recorded but never consulted: ${FIX_EXECUTORS.join(', ')}`)
    .option('--json', 'print workflow state as JSON')
    .action(async (workflowId: string, options: VerifyOptions) => {
      const workflow = await loadSecurityWorkflow(workflowId);
      const loaded = await loadSecurityConfig(workflow.root);
      const timeoutMs = positiveInteger(options.timeout, '--timeout') * 1000;
      const updated = await runWorkflowVerification({
        workflow,
        checks: loaded.config.checks,
        timeoutMs,
        executor: options.executor ? parseExecutor(options.executor) : undefined,
      });
      if (options.record) await writeFixRecord(updated, options.record, !options.json);
      if (options.json) console.log(JSON.stringify(updated, null, 2));
      else {
        console.log(`Workflow ${updated.id} · ${updated.state} · ${updated.verification?.assurance} · ${updated.latestScan.findings.length} finding(s)`);
        if (updated.verification?.record) console.log(renderFixRecord(updated.verification.record));
      }
      if (updated.state !== 'passed') process.exitCode = EXIT.gateNotMet;
    });

  parent
    .command('verify-fix')
    .description('Re-derive a Verified Fix Record offline — no workspace, no network, no Dvalin state')
    .argument('<record>', 'fix record JSON issued by `dvalin verify --record`')
    .option('--json', 'print the verification result as JSON')
    .action(async (recordPath: string, options: { json?: boolean }) => {
      const target = path.resolve(process.cwd(), recordPath);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
      } catch (error) {
        throw new UsageError(`Cannot read fix record ${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const check = verifyFixRecord(parsed);
      if (options.json) {
        // A machine caller gets an answer in every case, including this one;
        // the exit code, not the presence of output, carries the distinction.
        console.log(JSON.stringify({ schemaVersion: SECURITY_SCHEMA_VERSION, path: target, ...check }, null, 2));
        process.exitCode = check.record ? (check.ok ? EXIT.ok : EXIT.gateNotMet) : EXIT.usageError;
        return;
      }
      // Pointing at the wrong file is a usage error; a real record that fails
      // to re-derive is a gate result. A pipeline has to tell those apart.
      if (!check.record) throw new UsageError(`Not a Dvalin fix record: ${target}`);
      if (check.ok) {
        console.log(renderFixRecord(check.record));
        console.log('\nRe-derived successfully: this record is unmodified and its verdict follows from its own evidence.');
        console.log('It attests that these findings were gone and these checks were observed to pass. It is not a claim that the code is free of vulnerabilities.');
      } else {
        console.log('This fix record did not re-derive:');
        for (const reason of check.reasons) console.log(`  · ${reason}`);
      }
      // A record that does not re-derive is an answer, not a broken command.
      if (!check.ok) process.exitCode = EXIT.gateNotMet;
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
      delta = compareWithBaseline(
        suppression.result,
        await readSecurityBaseline(root, config.baseline),
        { suppressed: suppression.suppressed },
      );
    } catch (error) {
      throw new UsageError(`${error instanceof Error ? error.message : String(error)}. Run \`dvalin baseline\` before using a new-findings gate.`);
    }
  }
  const gate = evaluateSecurityGate({ result: suppression.result, threshold: config.gate.severity, mode: config.gate.mode, delta });
  const coverage = deriveCoverage(suppression.result, { suppressed: suppression.suppressed });
  const workflow = input.saveWorkflow === false
    ? undefined
    : await createSecurityWorkflow({ root, result: suppression.result, gate, delta, coverage });
  return {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    scan: suppression.result,
    coverage,
    delta,
    gate,
    root,
    config,
    workflow,
    suppressed: suppression.suppressed.length,
    expiredSuppressions: suppression.expired.length,
  };
}

export async function executeSecuritySarifImport(input: {
  root: string;
  reportPath: string;
  persist?: boolean;
}): Promise<SecuritySarifImport> {
  const root = await resolveWorkspaceRoot(input.root);
  const reportPath = path.resolve(input.reportPath);
  let reportText: string;
  try {
    reportText = await readUtf8FileWithLimit(reportPath, MAX_SECURITY_SARIF_IMPORT_BYTES);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Cannot read SARIF report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let report: unknown;
  try {
    report = JSON.parse(reportText) as unknown;
  } catch (error) {
    throw new UsageError(`Invalid SARIF JSON in ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = await parseSarifForRemediation(report, { cwd: root }).catch(error => {
    throw new UsageError(`Cannot import SARIF report ${reportPath}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const persisted = input.persist !== false;
  const cases = persisted
    ? await upsertRemediationCases({ cwd: root, findings: parsed.findings })
    : [];
  return {
    schemaVersion: 1,
    kind: 'dvalin-security-import',
    root,
    reportPath,
    source: parsed.source,
    totalResults: parsed.totalResults,
    skippedResults: parsed.skippedResults,
    findings: parsed.findings,
    cases,
    persisted,
  };
}

async function readUtf8FileWithLimit(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new UsageError(`SARIF report is not a regular file: ${file}`);
    if (info.size > maxBytes) {
      throw new UsageError(`SARIF report exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB import limit: ${file}`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = maxBytes + 1 - totalBytes;
      if (remaining <= 0) {
        throw new UsageError(`SARIF report exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB import limit: ${file}`);
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw new UsageError(`SARIF report exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB import limit: ${file}`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  } finally {
    await handle.close();
  }
}

function renderSecurityExecution(execution: ExecutedSecurityScan, limit: number): string {
  const lines = [renderDvalinResult(execution.scan, execution.root, limit)];
  if (execution.delta) {
    const delta = execution.delta;
    const parts = [
      `${delta.new.length} new`,
      `${delta.existing.length} existing`,
      `${delta.resolved.length} resolved`,
    ];
    if (delta.reopened.length) parts.push(`${delta.reopened.length} reopened`);
    if (delta.dismissed.length) parts.push(`${delta.dismissed.length} dismissed`);
    // Never fold this into "resolved": these were not looked for.
    if (delta.unknown.length) parts.push(`${delta.unknown.length} unknown`);
    lines.push('', `Baseline delta · ${parts.join(' · ')}`);
  }
  lines.push(renderCoverage(execution.coverage));
  if (execution.suppressed) lines.push(`Suppressed: ${execution.suppressed}`);
  if (execution.expiredSuppressions) lines.push(`Expired suppressions: ${execution.expiredSuppressions}`);
  lines.push(`Gate: ${execution.gate.passed ? 'PASS' : 'FAIL'} · ${execution.gate.mode} findings · threshold ${execution.gate.threshold}`);
  if (execution.workflow) lines.push(`Workflow: ${execution.workflow.id}`);
  return lines.join('\n');
}

/**
 * State the coverage next to the verdict, always. A gate result read without it
 * says more than the scan knows.
 */
export function renderCoverage(coverage: SecurityCoverage): string {
  const lines = [`Coverage: ${coverage.status}`];
  for (const entry of coverage.deferred) lines.push(`  · deferred: ${entry}`);
  for (const entry of coverage.exclusions) lines.push(`  · excluded: ${entry}`);
  for (const note of coverage.notes) lines.push(`  · ${note}`);
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

export function parseExecutor(value: string): FixExecutor {
  if ((FIX_EXECUTORS as readonly string[]).includes(value)) return value as FixExecutor;
  throw new UsageError(`--executor must be one of ${FIX_EXECUTORS.join(', ')}.`);
}

async function writeFixRecord(workflow: SecurityWorkflow, file: string, announce: boolean): Promise<void> {
  const record = workflow.verification?.record;
  if (!record) throw new UsageError('This workflow has no fix record to write.');
  const target = path.resolve(process.cwd(), file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  if (announce) console.log(`Fix record written to ${target}`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
