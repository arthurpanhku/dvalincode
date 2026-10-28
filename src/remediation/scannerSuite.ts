import { access, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { checkCommand, loadPolicy } from '../core/policy.js';
import { buildShellScript, runGovernedExecutable } from '../core/subprocessSandbox.js';
import { resolveWorkspaceRoot } from '../core/workspace.js';
import { isWithinDiffScope, type DiffScope } from './diffScope.js';
import { runLocalSecurityScan } from './localScan.js';
import { parseSarifForRemediation, type RemediationFinding } from './sarif.js';

export type DvalinScannerId = 'builtin' | 'semgrep' | 'trivy' | 'osv-scanner' | 'snyk-code' | 'snyk-oss' | 'codeql';

export const DVALIN_SCANNER_IDS: DvalinScannerId[] = ['builtin', 'semgrep', 'trivy', 'osv-scanner', 'snyk-code', 'snyk-oss', 'codeql'];

/**
 * What runs when nobody named the engines.
 *
 * Snyk is not here, and not by oversight: Snyk Code uploads source to Snyk's
 * service and both engines need an account. A scan that sends code off the
 * machine has to be asked for by name, in the policy file or on the command
 * line — never reached by leaving a flag out. CodeQL is not here either: it
 * builds a database per language, which takes minutes rather than seconds, and
 * its license limits where it may run.
 */
export const DEFAULT_SCANNER_IDS: DvalinScannerId[] = ['builtin', 'semgrep', 'trivy', 'osv-scanner'];

export type DvalinScannerDescriptor = {
  id: DvalinScannerId;
  name: string;
  category: 'sast' | 'supply-chain' | 'secrets' | 'misconfiguration';
  description: string;
  available: boolean;
  /** Sends code or dependency data to a third-party service and needs an account there. */
  remote?: boolean;
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
  /** Parts of the tree a completed engine could not analyse; they make coverage partial. */
  deferred?: string[];
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
  /**
   * Results the engine itself marked suppressed (SARIF `suppressions`), by its
   * own ignore policy. Not findings, and not silently gone either: coverage
   * lists them as exclusions.
   */
  suppressedResults?: number;
  scanners: DvalinScannerRun[];
  metrics: DvalinScanMetrics;
  /** Set when the scan was narrowed to a diff; absent for a whole-workspace scan. */
  scope?: { ref: string; files: number };
  /** Set when per-file engines analysed only some files. Not a verdict on its own. */
  narrowed?: { files: number; engines: DvalinScannerId[] };
};

type ExternalScanner = {
  descriptor: Omit<DvalinScannerDescriptor, 'available'>;
  command: string;
  /** `files` (workspace-relative), when given, narrows engines that analyse file by file. */
  args: (root: string, output: string, files?: string[]) => string[];
  /**
   * For engines that need more than one invocation of `command`: every step is
   * policy-checked and run in order, and every output is read. Replaces `args`.
   */
  plan?: (root: string, outputDir: string) => Promise<EnginePlan>;
  acceptedExitCodes: number[];
  allowMissingOutput?: boolean;
};

type EnginePlan = {
  steps: string[][];
  outputs: string[];
  /** What the plan leaves unanalysed, reported on the run instead of passing as covered. */
  deferred?: string[];
  /** Scratch space outside the workspace, removed once the engine finishes. */
  scratch?: string;
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
    // Narrowed by --include on the root, never by naming files as targets:
    // Semgrep scans an explicitly named file even when .semgrepignore or its
    // default ignores exclude it, and a narrowed round must not report what a
    // full scan would skip. A leading slash anchors the pattern to the root.
    args: (root, output, files) => [
      'scan', '--config', 'p/default', '--sarif', '--output', output, '--metrics', 'off',
      '--exclude', '.dvalin-scan-*', ...(files ?? []).flatMap(file => ['--include', `/${escapeGlob(file)}`]), root,
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
    // `--output`, though the docs now say `--output-file`: that flag arrived in
    // v2.3.4, and earlier releases reject it as undefined and exit 127. Every
    // release since still honors `--output`, with a deprecation warning.
    args: (root, output) => [
      'scan', 'source', '--recursive', '--format', 'sarif', '--output', output, root,
    ],
    acceptedExitCodes: [0, 1, 128],
    allowMissingOutput: true,
  },
  // Snyk, so the loop is measured with the same scanner that blocks the merge.
  // A fix verified against a different engine than the CI gate is a fix the
  // gate can still reject. Both need `snyk auth` or SNYK_TOKEN; a missing or
  // rejected token exits 2, which is reported as an error and leaves the
  // scan's coverage partial rather than silently clean.
  //
  // Exit codes: 0 no issues, 1 issues found, 2 failure, 3 nothing Snyk
  // supports in this tree (no output written, so nothing to report).
  {
    descriptor: {
      id: 'snyk-code',
      name: 'Snyk Code',
      category: 'sast',
      description: 'Snyk SAST. Uploads source to Snyk for analysis; needs a Snyk account (snyk auth or SNYK_TOKEN).',
      installCommand: 'npm install -g snyk',
      homepage: 'https://docs.snyk.io/snyk-cli/commands/code-test',
      remote: true,
    },
    command: 'snyk',
    args: (root, output) => ['code', 'test', root, `--sarif-file-output=${output}`],
    acceptedExitCodes: [0, 1, 3],
    allowMissingOutput: true,
  },
  {
    descriptor: {
      id: 'snyk-oss',
      name: 'Snyk Open Source',
      category: 'supply-chain',
      description: 'Snyk dependency vulnerability scanning across every manifest in the tree; needs a Snyk account (snyk auth or SNYK_TOKEN).',
      installCommand: 'npm install -g snyk',
      homepage: 'https://docs.snyk.io/snyk-cli/commands/test',
      remote: true,
    },
    command: 'snyk',
    args: (root, output) => ['test', root, '--all-projects', `--sarif-file-output=${output}`],
    acceptedExitCodes: [0, 1, 3],
    allowMissingOutput: true,
  },
  // CodeQL, for teams whose merge gate is GitHub code scanning: a fix verified
  // by a different engine is one that gate can still reject. One database and
  // one analysis per language found in the tree, each with that language's
  // default code-scanning query suite, so the findings match what the gate
  // reports. Languages that need a build Dvalin cannot guess are named on the
  // run as deferred, so the scan reads as partial rather than clean.
  {
    descriptor: {
      id: 'codeql',
      name: 'CodeQL',
      category: 'sast',
      description: 'GitHub CodeQL semantic analysis with the default code-scanning queries. Its license covers open-source code and GitHub Advanced Security customers.',
      installCommand: 'brew install --cask codeql',
      homepage: 'https://codeql.github.com/docs/codeql-cli/',
    },
    command: 'codeql',
    args: () => [],
    plan: codeqlPlan,
    acceptedExitCodes: [0],
  },
];

/**
 * Languages CodeQL analyses without a build Dvalin would have to guess, by the
 * extensions that select them. Go has no source-only mode; its autobuild runs
 * `go build` with the project's own toolchain.
 */
const CODEQL_LANGUAGES: Array<{ language: string; extensions: string[]; autobuild?: boolean }> = [
  { language: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue'] },
  { language: 'python', extensions: ['.py'] },
  { language: 'ruby', extensions: ['.rb'] },
  { language: 'java', extensions: ['.java'] },
  { language: 'csharp', extensions: ['.cs'] },
  { language: 'go', extensions: ['.go'], autobuild: true },
];

/** Languages CodeQL supports only with the project's own build, which a scan cannot invent. */
const CODEQL_NEEDS_BUILD: Array<{ name: string; extensions: string[] }> = [
  { name: 'Kotlin', extensions: ['.kt', '.kts'] },
  { name: 'C/C++', extensions: ['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'] },
  { name: 'Swift', extensions: ['.swift'] },
];

const CODEQL_SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__']);
const CODEQL_DETECTION_LIMIT = 20_000;

/**
 * The CodeQL languages present in a tree, in a fixed order, and the languages
 * present that need a build.
 */
export async function detectCodeqlLanguages(root: string): Promise<{ languages: string[]; needsBuild: string[]; truncated: boolean }> {
  const found = new Set<string>();
  const unbuilt = new Set<string>();
  const queue = [root];
  let visited = 0;
  while (queue.length && visited < CODEQL_DETECTION_LIMIT) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited++;
      if (entry.isDirectory()) {
        if (!CODEQL_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.dvalin-scan-')) queue.push(path.join(directory, entry.name));
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      const match = CODEQL_LANGUAGES.find(candidate => candidate.extensions.includes(extension));
      if (match) found.add(match.language);
      const unsupported = CODEQL_NEEDS_BUILD.find(candidate => candidate.extensions.includes(extension));
      if (unsupported) unbuilt.add(unsupported.name);
    }
  }
  return {
    languages: CODEQL_LANGUAGES.map(candidate => candidate.language).filter(language => found.has(language)),
    needsBuild: CODEQL_NEEDS_BUILD.map(candidate => candidate.name).filter(name => unbuilt.has(name)),
    truncated: queue.length > 0,
  };
}

async function codeqlPlan(root: string, outputDir: string): Promise<EnginePlan> {
  const { languages, needsBuild, truncated } = await detectCodeqlLanguages(root);
  const deferred = needsBuild.map(name => `${name} not analysed: CodeQL needs the project's build for it`);
  if (truncated) deferred.push(`language detection stopped after ${CODEQL_DETECTION_LIMIT} entries; a language seen only past that was not analysed`);
  if (!languages.length) return { steps: [], outputs: [], deferred };
  // Databases go outside the workspace: an extractor walking the source root
  // must not index the database it is writing.
  const scratch = await mkdtemp(path.join(tmpdir(), 'dvalin-codeql-'));
  const steps: string[][] = [];
  const outputs: string[] = [];
  for (const language of languages) {
    const database = path.join(scratch, language);
    const output = path.join(outputDir, `codeql-${language}.sarif`);
    const autobuild = CODEQL_LANGUAGES.find(candidate => candidate.language === language)?.autobuild;
    steps.push(
      ['database', 'create', database, `--language=${language}`, ...(autobuild ? [] : ['--build-mode=none']), `--source-root=${root}`, '--overwrite'],
      ['database', 'analyze', database, `codeql/${language}-queries`, '--format=sarif-latest', `--output=${output}`,
        `--sarif-category=${language}`, '--download'],
    );
    outputs.push(output);
  }
  return { steps, outputs, scratch, deferred };
}

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

/** Above this many files a narrowed scan gains little, and argv limits start to bite. */
export const MAX_NARROWED_FILES = 200;

/**
 * Engines whose analysis is per file, so scanning only some files reports
 * exactly what a full scan would report for those files. Everything else —
 * dependency engines, Trivy's misconfiguration checks, Snyk Code's interfile
 * analysis — always scans the whole root.
 */
const NARROWABLE: ReadonlySet<DvalinScannerId> = new Set(['builtin', 'semgrep']);

export type DvalinScanSuiteOptions = {
  scanners?: DvalinScannerId[];
  timeoutMs?: number;
  /** Report only on these lines (a diff). Filters every engine's results. */
  scope?: DiffScope;
  /**
   * Analyse only these workspace-relative files, with the engines that work
   * file by file; the rest scan in full and are not filtered. Used between fix
   * rounds. A narrowed result is never a verdict — callers confirm with a full
   * scan before deciding anything.
   */
  narrow?: { files: string[] };
};

type EngineOutcome = {
  run: DvalinScannerRun;
  findings: RemediationFinding[];
  totalResults: number;
  skippedResults: number;
  suppressedResults: number;
};

export async function runDvalinScanSuite(
  cwd: string,
  options: DvalinScanSuiteOptions = {},
): Promise<DvalinScanSuiteResult> {
  const root = await resolveWorkspaceRoot(cwd);
  const started = new Date();
  const selected = new Set<DvalinScannerId>(options.scanners?.length ? options.scanners : DEFAULT_SCANNER_IDS);
  const narrowFiles = narrowedFiles(root, options.narrow);
  const narrowed = (id: DvalinScannerId) => narrowFiles !== undefined && NARROWABLE.has(id);

  const outputDir = path.join(root, `.dvalin-scan-${randomUUID().slice(0, 8)}`);
  const resolvedOutputDir = path.resolve(outputDir);
  const outputRelative = path.relative(root, resolvedOutputDir);
  if (outputRelative.startsWith('..') || path.isAbsolute(outputRelative)) {
    throw new Error(`Refusing to create scanner output directory outside workspace: ${resolvedOutputDir}`);
  }

  const builtinJob = async (): Promise<EngineOutcome> => {
    const t0 = Date.now();
    // A narrowed set is whole files: a scope with no line detail.
    const scope = narrowFiles ? { ref: 'narrowed', files: new Set(narrowFiles), lines: new Map() } : options.scope;
    const result = await runLocalSecurityScan(root, scope);
    return {
      run: { ...BUILTIN, status: 'completed', findings: result.findings.length, durationMs: Date.now() - t0 },
      findings: result.findings.map(finding => ({ ...finding, scanner: 'builtin' as const })),
      totalResults: result.totalResults,
      skippedResults: result.skippedResults,
      suppressedResults: 0,
    };
  };

  // Engines run side by side; the round costs the slowest one rather than the
  // sum. Engines sharing an executable (both Snyk engines are `snyk`) take
  // turns, so two processes never contend for one tool's config and cache.
  const external = EXTERNAL_SCANNERS.filter(scanner => selected.has(scanner.descriptor.id));
  const byCommand = new Map<string, ExternalScanner[]>();
  for (const scanner of external) byCommand.set(scanner.command, [...(byCommand.get(scanner.command) ?? []), scanner]);

  const outcomes = new Map<DvalinScannerId, EngineOutcome>();
  await mkdir(resolvedOutputDir, { recursive: false });
  try {
    const policy = loadPolicy(root).policy;
    const context = { root, outputDir: resolvedOutputDir, policy, timeoutMs: options.timeoutMs };
    await Promise.all([
      ...(selected.has('builtin') ? [builtinJob().then(outcome => { outcomes.set('builtin', outcome); })] : []),
      ...[...byCommand.values()].map(async group => {
        for (const scanner of group) {
          const files = narrowed(scanner.descriptor.id) ? narrowFiles : undefined;
          outcomes.set(scanner.descriptor.id, await runExternalEngine(scanner, context, files));
        }
      }),
    ]);
  } finally {
    await rm(resolvedOutputDir, { recursive: true, force: true });
  }

  // Assemble in the canonical engine order, so the result does not depend on
  // which engine happened to finish first.
  const findings: RemediationFinding[] = [];
  const runs: DvalinScannerRun[] = [];
  let totalResults = 0;
  let skippedResults = 0;
  let suppressedResults = 0;
  for (const id of ['builtin', ...EXTERNAL_SCANNERS.map(scanner => scanner.descriptor.id)] as DvalinScannerId[]) {
    const outcome = outcomes.get(id);
    if (!outcome) continue;
    runs.push(outcome.run);
    findings.push(...outcome.findings);
    totalResults += outcome.totalResults;
    skippedResults += outcome.skippedResults;
    suppressedResults += outcome.suppressedResults;
  }

  // The builtin scanner is narrowed before it reads anything, but the external
  // ones only take a root. Filtering here catches all of them at once, because
  // `normalizeSarifPath` has already made every path workspace-relative.
  const scoped = options.scope === undefined
    ? findings
    : findings.filter(finding => isWithinDiffScope(options.scope!, finding.path, finding.startLine));
  const deduped = dedupeFindings(scoped);
  const metrics = scanMetrics(deduped);
  const score = scoreFindings(metrics);
  const narrowedEngines = narrowFiles ? runs.map(run => run.id).filter(narrowed) : [];
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
    ...(suppressedResults ? { suppressedResults } : {}),
    scanners: runs,
    metrics,
    ...(options.scope === undefined ? {} : { scope: { ref: options.scope.ref, files: options.scope.files.size } }),
    ...(narrowFiles ? { narrowed: { files: narrowFiles.length, engines: narrowedEngines } } : {}),
  };
}

/**
 * The files a narrowed scan may restrict itself to, or undefined for a full
 * scan: no request, nothing to narrow to, or too many to be worth it. Paths
 * that escape the workspace or no longer exist are dropped.
 */
function narrowedFiles(root: string, narrow: DvalinScanSuiteOptions['narrow']): string[] | undefined {
  if (!narrow) return undefined;
  const files = [...new Set(narrow.files.map(file => file.replace(/\\/g, '/')))]
    .filter(file => {
      const relative = path.relative(root, path.resolve(root, file));
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
        // A deleted file has nothing left to analyse, and an engine handed a
        // missing path errors instead of reporting.
        && existsSync(path.join(root, file));
    })
    .sort();
  if (files.length === 0 || files.length > MAX_NARROWED_FILES) return undefined;
  return files;
}

async function runExternalEngine(
  scanner: ExternalScanner,
  context: { root: string; outputDir: string; policy: ReturnType<typeof loadPolicy>['policy']; timeoutMs?: number },
  narrowTo?: string[],
): Promise<EngineOutcome> {
  const t0 = Date.now();
  const empty = { findings: [], totalResults: 0, skippedResults: 0, suppressedResults: 0 };
  const executable = await findExecutable(scanner.command);
  const descriptor: DvalinScannerDescriptor = { ...scanner.descriptor, available: Boolean(executable) };
  if (!executable) {
    return { ...empty, run: { ...descriptor, status: 'missing', findings: 0, durationMs: Date.now() - t0 } };
  }

  let plan: EnginePlan | undefined;
  try {
    if (scanner.plan) {
      plan = await scanner.plan(context.root, context.outputDir);
    } else {
      const output = path.join(context.outputDir, `${scanner.descriptor.id}.sarif`);
      plan = { steps: [scanner.args(context.root, output, narrowTo)], outputs: [output] };
    }
    // Every step is checked before any runs: a plan the policy would stop
    // halfway must not leave half its work behind.
    for (const args of plan.steps) {
      const commandDecision = checkCommand(context.policy, buildShellScript(scanner.command, args));
      if (!commandDecision.allowed) {
        return {
          ...empty,
          run: { ...descriptor, status: 'error', findings: 0, durationMs: Date.now() - t0, error: `Blocked by policy: ${commandDecision.rule}` },
        };
      }
    }

    for (const args of plan.steps) {
      const processResult = await runGovernedExecutable({
        command: scanner.command,
        args,
        cwd: context.root,
        timeoutMs: context.timeoutMs ?? 300_000,
        policy: context.policy,
        toolName: 'run_security_suite',
        preferSandboxWhenUnrestricted: true,
        skipNetworkSandboxWhenPolicyAllows: true,
      });
      if (!scanner.acceptedExitCodes.includes(processResult.exitCode ?? -1)) {
        throw new Error(processResult.output.trim() || `${scanner.descriptor.name} exited ${processResult.exitCode}`);
      }
    }

    const outcome = { findings: [] as RemediationFinding[], totalResults: 0, skippedResults: 0, suppressedResults: 0 };
    for (const output of plan.outputs) {
      if (scanner.allowMissingOutput) {
        try {
          await access(output, constants.R_OK);
        } catch {
          continue;
        }
      }
      const report = JSON.parse(await readFile(output, 'utf8')) as unknown;
      const result = await parseSarifForRemediation(report, { cwd: context.root });
      // Stamp the engine here, where it is known. The delta needs it to tell
      // "we looked and it is gone" from "this engine never ran".
      outcome.findings.push(...result.findings.map(finding => ({ ...finding, scanner: scanner.descriptor.id })));
      outcome.totalResults += result.totalResults;
      outcome.skippedResults += result.skippedResults;
      outcome.suppressedResults += result.suppressedResults ?? 0;
    }
    return {
      ...outcome,
      run: {
        ...descriptor,
        status: 'completed',
        findings: outcome.findings.length,
        durationMs: Date.now() - t0,
        ...(plan.deferred?.length ? { deferred: plan.deferred } : {}),
      },
    };
  } catch (error) {
    return {
      ...empty,
      run: { ...descriptor, status: 'error', findings: 0, durationMs: Date.now() - t0, error: compactError(error) },
    };
  } finally {
    if (plan?.scratch) await rm(plan.scratch, { recursive: true, force: true });
  }
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

/** Match a path literally in a gitignore-style pattern. */
function escapeGlob(file: string): string {
  return file.replace(/[\\*?[\]!]/g, character => `\\${character}`);
}

function compactError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  // Tools print the reason they failed last; the head of a long output is
  // usually banners and environment notices.
  return message.length > 500 ? `…${message.slice(-499)}` : message;
}

function scannerInstaller(id: DvalinScannerId): { command: string; args: string[] } | null {
  if (id === 'semgrep') return { command: 'python3', args: ['-m', 'pip', 'install', 'semgrep'] };
  if (id === 'trivy') return { command: 'brew', args: ['install', 'trivy'] };
  if (id === 'osv-scanner') return { command: 'brew', args: ['install', 'osv-scanner'] };
  if (id === 'snyk-code' || id === 'snyk-oss') return { command: 'npm', args: ['install', '-g', 'snyk'] };
  if (id === 'codeql') return { command: 'brew', args: ['install', '--cask', 'codeql'] };
  return null;
}
