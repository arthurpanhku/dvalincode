import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkCommand, loadPolicy } from '../core/policy.js';
import { buildShellScript, runGovernedExecutable } from '../core/subprocessSandbox.js';
import { resolveWorkspaceRoot } from '../core/workspace.js';
import { runLocalSecurityScan } from './localScan.js';
import { parseSarifForRemediation, type RemediationFinding } from './sarif.js';

export type DvalinScannerId = 'builtin' | 'semgrep' | 'trivy' | 'osv-scanner';

export const DVALIN_SCANNER_IDS: DvalinScannerId[] = ['builtin', 'semgrep', 'trivy', 'osv-scanner'];

export type DvalinScannerDescriptor = {
  id: DvalinScannerId;
  name: string;
  category: 'sast' | 'supply-chain' | 'secrets' | 'misconfiguration';
  description: string;
  available: boolean;
  installCommand?: string;
  homepage: string;
};

export type DvalinScannerInstallPlan = {
  scanner: DvalinScannerId;
  supported: boolean;
  command?: string;
  reason?: string;
};

export type DvalinScannerRun = DvalinScannerDescriptor & {
  status: 'completed' | 'missing' | 'error';
  findings: number;
  durationMs: number;
  error?: string;
};

export type DvalinScanMetrics = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  files: number;
  rules: number;
};

export type DvalinScanSuiteResult = {
  id: string;
  source: 'Dvalin Security Suite';
  startedAt: string;
  completedAt: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: RemediationFinding[];
  totalResults: number;
  skippedResults: number;
  scanners: DvalinScannerRun[];
  metrics: DvalinScanMetrics;
};

type ExternalScanner = {
  descriptor: Omit<DvalinScannerDescriptor, 'available'>;
  command: string;
  args: (root: string, output: string) => string[];
  acceptedExitCodes: number[];
  allowMissingOutput?: boolean;
};

const EXTERNAL_SCANNERS: ExternalScanner[] = [
  {
    descriptor: {
      id: 'semgrep',
      name: 'Semgrep CE',
      category: 'sast',
      description: 'Multi-language semantic SAST using the Semgrep community rules registry.',
      installCommand: 'python3 -m pip install semgrep',
      homepage: 'https://semgrep.dev/products/community-edition/',
    },
    command: 'semgrep',
    args: (root, output) => [
      'scan', '--config', 'p/default', '--sarif', '--output', output, '--metrics', 'off',
      '--exclude', '.dvalin-scan-*', root,
    ],
    acceptedExitCodes: [0],
  },
  {
    descriptor: {
      id: 'trivy',
      name: 'Trivy',
      category: 'misconfiguration',
      description: 'Filesystem vulnerability, secret, and infrastructure misconfiguration scanning.',
      installCommand: 'brew install trivy',
      homepage: 'https://trivy.dev/docs/latest/target/filesystem/',
    },
    command: 'trivy',
    args: (root, output) => [
      'fs', '--format', 'sarif', '--output', output, '--scanners', 'vuln,misconfig,secret',
      '--no-progress', '--skip-dirs', 'node_modules', '--skip-dirs', '.git',
      '--skip-dirs', '.dvalin-scan-*', root,
    ],
    acceptedExitCodes: [0],
  },
  {
    descriptor: {
      id: 'osv-scanner',
      name: 'OSV-Scanner',
      category: 'supply-chain',
      description: 'Dependency vulnerability matching against the open OSV advisory database.',
      installCommand: 'brew install osv-scanner',
      homepage: 'https://google.github.io/osv-scanner/',
    },
    command: 'osv-scanner',
    args: (root, output) => [
      'scan', 'source', '--recursive', '--format', 'sarif', '--output-file', output, root,
    ],
    acceptedExitCodes: [0, 1, 128],
    allowMissingOutput: true,
  },
];

const BUILTIN: DvalinScannerDescriptor = {
  id: 'builtin',
  name: 'Dvalin Built-in',
  category: 'secrets',
  description: 'Fast local high-signal rules for secrets, injection, XSS, eval, and unsafe shell use.',
  available: true,
  homepage: 'https://github.com/arthurpanhku/dvalincode',
};

export async function listDvalinScanners(): Promise<DvalinScannerDescriptor[]> {
  const external = await Promise.all(EXTERNAL_SCANNERS.map(async scanner => ({
    ...scanner.descriptor,
    available: Boolean(await findExecutable(scanner.command)),
  })));
  return [BUILTIN, ...external];
}

/**
 * Return a reviewable install plan. Dvalin never downloads or executes an
 * installer merely because a scan discovered that an optional engine is absent.
 */
export function dvalinScannerInstallPlan(id: DvalinScannerId): DvalinScannerInstallPlan {
  if (id === 'builtin') {
    return { scanner: id, supported: true, reason: 'Dvalin Built-in ships with the CLI; no installation is required.' };
  }
  const scanner = EXTERNAL_SCANNERS.find(candidate => candidate.descriptor.id === id);
  if (!scanner) return { scanner: id, supported: false, reason: `Unknown scanner: ${id}` };
  if (!scanner.descriptor.installCommand) {
    return { scanner: id, supported: false, reason: `No managed install command is available for ${scanner.descriptor.name}.` };
  }
  return { scanner: id, supported: true, command: scanner.descriptor.installCommand };
}

/** Execute a previously reviewed, fixed installer argv under the resolved policy. */
export async function installDvalinScanner(cwd: string, id: DvalinScannerId): Promise<void> {
  const launch = scannerInstaller(id);
  if (!launch) {
    if (id === 'builtin') return;
    throw new Error(`No managed installer is available for ${id}.`);
  }
  const policy = loadPolicy(cwd).policy;
  const commandLine = buildShellScript(launch.command, launch.args);
  const decision = checkCommand(policy, commandLine);
  if (!decision.allowed) throw new Error(`Scanner installation blocked by policy: ${decision.rule}`);
  const result = await runGovernedExecutable({
    ...launch,
    cwd,
    timeoutMs: 600_000,
    policy,
    toolName: 'install_security_scanner',
    preferSandboxWhenUnrestricted: false,
    skipNetworkSandboxWhenPolicyAllows: true,
  });
  if (result.exitCode !== 0) throw new Error(result.output.trim() || `${launch.command} exited ${result.exitCode}`);
}

export async function runDvalinScanSuite(
  cwd: string,
  options: { scanners?: DvalinScannerId[]; timeoutMs?: number } = {},
): Promise<DvalinScanSuiteResult> {
  const root = await resolveWorkspaceRoot(cwd);
  const started = new Date();
  const selected = new Set(options.scanners?.length ? options.scanners : ['builtin', 'semgrep', 'trivy', 'osv-scanner']);
  const findings: RemediationFinding[] = [];
  const runs: DvalinScannerRun[] = [];
  let totalResults = 0;
  let skippedResults = 0;

  if (selected.has('builtin')) {
    const t0 = Date.now();
    const result = await runLocalSecurityScan(root);
    findings.push(...result.findings);
    totalResults += result.totalResults;
    skippedResults += result.skippedResults;
    runs.push({ ...BUILTIN, status: 'completed', findings: result.findings.length, durationMs: Date.now() - t0 });
  }

  const outputDir = path.join(root, `.dvalin-scan-${randomUUID().slice(0, 8)}`);
  const resolvedOutputDir = path.resolve(outputDir);
  const outputRelative = path.relative(root, resolvedOutputDir);
  if (outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
    throw new Error(`Refusing to create scanner output directory outside workspace: ${resolvedOutputDir}`);
  }
  await mkdir(resolvedOutputDir, { recursive: false });
  try {
    for (const scanner of EXTERNAL_SCANNERS) {
      if (!selected.has(scanner.descriptor.id)) continue;
      const t0 = Date.now();
      const executable = await findExecutable(scanner.command);
      const descriptor: DvalinScannerDescriptor = { ...scanner.descriptor, available: Boolean(executable) };
      if (!executable) {
        runs.push({ ...descriptor, status: 'missing', findings: 0, durationMs: Date.now() - t0 });
        continue;
      }

      const output = path.join(resolvedOutputDir, `${scanner.descriptor.id}.sarif`);
      const args = scanner.args(root, output);
      const loadedPolicy = loadPolicy(root);
      const commandLine = buildShellScript(scanner.command, args);
      const commandDecision = checkCommand(loadedPolicy.policy, commandLine);
      if (!commandDecision.allowed) {
        runs.push({
          ...descriptor,
          status: 'error',
          findings: 0,
          durationMs: Date.now() - t0,
          error: `Blocked by policy: ${commandDecision.rule}`,
        });
        continue;
      }

      try {
        const processResult = await runGovernedExecutable({
          command: scanner.command,
          args,
          cwd: root,
          timeoutMs: options.timeoutMs ?? 300_000,
          policy: loadedPolicy.policy,
          toolName: 'run_security_suite',
          preferSandboxWhenUnrestricted: true,
          skipNetworkSandboxWhenPolicyAllows: true,
        });
        if (!scanner.acceptedExitCodes.includes(processResult.exitCode ?? -1)) {
          throw new Error(processResult.output.trim() || `${scanner.descriptor.name} exited ${processResult.exitCode}`);
        }
        if (scanner.allowMissingOutput) {
          try {
            await access(output, constants.R_OK);
          } catch {
            runs.push({ ...descriptor, status: 'completed', findings: 0, durationMs: Date.now() - t0 });
            continue;
          }
        }
        const report = JSON.parse(await readFile(output, 'utf8')) as unknown;
        const result = await parseSarifForRemediation(report, { cwd: root });
        findings.push(...result.findings);
        totalResults += result.totalResults;
        skippedResults += result.skippedResults;
        runs.push({ ...descriptor, status: 'completed', findings: result.findings.length, durationMs: Date.now() - t0 });
      } catch (error) {
        runs.push({
          ...descriptor,
          status: 'error',
          findings: 0,
          durationMs: Date.now() - t0,
          error: compactError(error),
        });
      }
    }
  } finally {
    await rm(resolvedOutputDir, { recursive: true, force: true });
  }

  const deduped = dedupeFindings(findings);
  const metrics = scanMetrics(deduped);
  const score = scoreFindings(metrics);
  return {
    id: `scan-${started.toISOString().replace(/[:.]/g, '-')}`,
    source: 'Dvalin Security Suite',
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    score,
    grade: gradeFor(score),
    findings: deduped,
    totalResults,
    skippedResults,
    scanners: runs,
    metrics,
  };
}

function scanMetrics(findings: RemediationFinding[]): DvalinScanMetrics {
  const metrics: DvalinScanMetrics = { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 };
  const files = new Set<string>();
  const rules = new Set<string>();
  for (const finding of findings) {
    const score = Number.parseFloat(finding.securitySeverity ?? '');
    if (score >= 9) metrics.critical++;
    else if (finding.severity === 'error' || score >= 7) metrics.high++;
    else if (finding.severity === 'warning' || score >= 4) metrics.medium++;
    else metrics.low++;
    files.add(finding.path);
    rules.add(`${finding.source}:${finding.ruleId}`);
  }
  metrics.files = files.size;
  metrics.rules = rules.size;
  return metrics;
}

function scoreFindings(metrics: DvalinScanMetrics): number {
  return Math.max(0, 100 - metrics.critical * 22 - metrics.high * 12 - metrics.medium * 5 - metrics.low * 1);
}

function gradeFor(score: number): DvalinScanSuiteResult['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function dedupeFindings(findings: RemediationFinding[]): RemediationFinding[] {
  const unique = new Map<string, RemediationFinding>();
  for (const finding of findings) {
    const key = `${finding.source}:${finding.ruleId}:${finding.path}:${finding.startLine ?? 0}:${finding.message}`;
    if (!unique.has(key)) unique.set(key, finding);
  }
  return [...unique.values()].sort((a, b) => severityWeight(b) - severityWeight(a));
}

function severityWeight(finding: RemediationFinding): number {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (Number.isFinite(score)) return score;
  return finding.severity === 'error' ? 8 : finding.severity === 'warning' ? 5 : 1;
}

async function findExecutable(command: string): Promise<string | undefined> {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function scannerInstaller(id: DvalinScannerId): { command: string; args: string[] } | null {
  if (id === 'semgrep') return { command: 'python3', args: ['-m', 'pip', 'install', 'semgrep'] };
  if (id === 'trivy') return { command: 'brew', args: ['install', 'trivy'] };
  if (id === 'osv-scanner') return { command: 'brew', args: ['install', 'osv-scanner'] };
  return null;
}
