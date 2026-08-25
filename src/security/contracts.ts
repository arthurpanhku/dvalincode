import { createHash } from 'node:crypto';
import type { RemediationFinding } from '../remediation/sarif.js';
import type { DvalinScannerId, DvalinScannerRun, DvalinScanSuiteResult } from '../remediation/scannerSuite.js';

export const SECURITY_SCHEMA_VERSION = 2 as const;

/**
 * Versions this build can *read*. Writers always emit the current version.
 *
 * A baseline is committed to the user's repository, so raising the version
 * without accepting the previous one would break every repository that already
 * has one on the first upgrade. Records written before coverage existed load
 * fine and simply report `unknown` coverage — which is the honest answer for a
 * scan that never recorded what it looked at.
 */
export const SUPPORTED_SECURITY_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type SecuritySeverity = typeof SECURITY_SEVERITIES[number];
export type SecurityThreshold = SecuritySeverity | 'none';
export type SecurityGateMode = 'all' | 'new';

export type SecurityFindingSnapshot = {
  fingerprint: string;
  targetFingerprint: string;
  findingId: string;
  source: string;
  /**
   * Which engine produced this finding. Absent on records written before the
   * field existed, and on imported SARIF from a tool outside the fleet; the
   * delta falls back to matching `source` by name and, failing that, treats the
   * finding's coverage as unattributable.
   */
  scanner?: DvalinScannerId;
  ruleId: string;
  ruleName?: string;
  severity: RemediationFinding['severity'];
  securitySeverity?: string;
  message: string;
  path: string;
  startLine?: number;
  endLine?: number;
  helpUri?: string;
  tags: string[];
};

export type SecurityBaseline = {
  schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  kind: 'dvalin-security-baseline';
  createdAt: string;
  scanId: string;
  scanners: DvalinScannerId[];
  /** Absent on baselines written before coverage was recorded. */
  coverage?: SecurityCoverage;
  findings: SecurityFindingSnapshot[];
};

export const SECURITY_COVERAGE_STATUSES = ['complete', 'partial', 'unknown'] as const;
export type SecurityCoverageStatus = typeof SECURITY_COVERAGE_STATUSES[number];

/**
 * What the scan actually looked at.
 *
 * A gate result means nothing without it: "no findings" from a run where
 * Semgrep was not installed and half the results were dropped is not the same
 * answer as "no findings" from a complete run, and reporting them identically
 * is the way a number stops meaning anything.
 */
export type SecurityCoverage = {
  status: SecurityCoverageStatus;
  /** Per-engine outcome for the engines this scan selected. */
  scanners: Array<{ id: DvalinScannerId; status: DvalinScannerRun['status'] }>;
  /** Deliberately not looked at: suppressions, ignore rules, policy denials. */
  exclusions: string[];
  /** Not fully examined, though nothing chose to skip it. */
  deferred: string[];
  notes: string[];
};

/**
 * How each finding moved since the baseline.
 *
 * `unknown` exists because the alternative is a lie: a baseline finding absent
 * from a run whose engine never executed has not been resolved, it has not been
 * looked for. Before this field, such findings were reported as `resolved`.
 */
export type SecurityFindingDelta = {
  new: SecurityFindingSnapshot[];
  existing: SecurityFindingSnapshot[];
  resolved: SecurityFindingSnapshot[];
  /** Gone from the baseline by fingerprint, but the same rule is back in the same file. */
  reopened: SecurityFindingSnapshot[];
  /** Removed by an active suppression, with a recorded reason. */
  dismissed: SecurityFindingSnapshot[];
  /** Cannot be judged: the engine that would have found it did not complete. */
  unknown: SecurityFindingSnapshot[];
};

export type SecurityGateResult = {
  passed: boolean;
  mode: SecurityGateMode;
  threshold: SecurityThreshold;
  considered: number;
  blocking: SecurityFindingSnapshot[];
};

export type SecurityScanEnvelope = {
  schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  scan: DvalinScanSuiteResult;
  coverage: SecurityCoverage;
  delta?: SecurityFindingDelta;
  gate: SecurityGateResult;
};

export function severityOfFinding(finding: Pick<RemediationFinding, 'severity' | 'securitySeverity'>): SecuritySeverity {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (score >= 9) return 'critical';
  if (finding.severity === 'error' || score >= 7) return 'high';
  if (finding.severity === 'warning' || score >= 4) return 'medium';
  return 'low';
}

export function findingFingerprint(finding: Pick<RemediationFinding, 'id' | 'source' | 'ruleId' | 'path' | 'startLine' | 'message'>): string {
  return digest([
    finding.source,
    finding.id,
    finding.ruleId,
    normalizePath(finding.path),
    String(finding.startLine ?? 0),
    finding.message.trim().replace(/\s+/g, ' '),
  ]);
}

/** A conservative verification key: a moved instance of the same rule in the same file still remains a target. */
export function findingTargetFingerprint(finding: Pick<RemediationFinding, 'source' | 'ruleId' | 'path'>): string {
  return digest([finding.source, finding.ruleId, normalizePath(finding.path)]);
}

/**
 * Best-effort engine attribution for a finding.
 *
 * The suite tags its own findings at scan time; this name match is the fallback
 * for records written before that tag existed. When neither resolves, the
 * caller must treat the finding as unattributable rather than guessing.
 */
export function scannerIdForSource(source: string): DvalinScannerId | undefined {
  const name = source.toLowerCase();
  if (name.includes('dvalin')) return 'builtin';
  if (name.includes('semgrep')) return 'semgrep';
  if (name.includes('trivy')) return 'trivy';
  if (name.includes('osv')) return 'osv-scanner';
  return undefined;
}

export function snapshotFinding(finding: RemediationFinding): SecurityFindingSnapshot {
  const scanner = finding.scanner ?? scannerIdForSource(finding.source);
  return {
    fingerprint: findingFingerprint(finding),
    targetFingerprint: findingTargetFingerprint(finding),
    findingId: finding.id,
    source: finding.source,
    ...(scanner ? { scanner } : {}),
    ruleId: finding.ruleId,
    ruleName: finding.ruleName,
    severity: finding.severity,
    securitySeverity: finding.securitySeverity,
    message: finding.message,
    path: normalizePath(finding.path),
    startLine: finding.startLine,
    endLine: finding.endLine,
    helpUri: finding.helpUri,
    tags: [...finding.tags],
  };
}

/**
 * Describe what a completed scan actually covered, from facts the suite already
 * recorded. Nothing here re-scans or estimates.
 */
export function deriveCoverage(
  result: DvalinScanSuiteResult,
  options: { suppressed?: Array<{ finding: Pick<RemediationFinding, 'path' | 'ruleId'> }> } = {},
): SecurityCoverage {
  const scanners = result.scanners.map(scanner => ({ id: scanner.id, status: scanner.status }));
  const exclusions: string[] = [];
  const deferred: string[] = [];
  const notes: string[] = [];

  const incomplete = result.scanners.filter(scanner => scanner.status !== 'completed');
  for (const scanner of incomplete) {
    deferred.push(`${scanner.name}: ${scanner.status}${scanner.error ? ` — ${scanner.error}` : ''}`);
  }
  if (result.skippedResults > 0) {
    deferred.push(`${result.skippedResults} scanner result(s) dropped for lacking a safe workspace location`);
  }
  if (result.scope) {
    // A scoped run answers "did this change introduce anything?". It has never
    // seen the rest of the repository and must not imply that it has.
    deferred.push(`scoped to ${result.scope.ref} (${result.scope.files} file(s)); the rest of the workspace was not scanned`);
  }
  const suppressed = options.suppressed ?? [];
  for (const entry of suppressed) {
    exclusions.push(`${entry.finding.ruleId} in ${entry.finding.path} (suppressed)`);
  }

  let status: SecurityCoverageStatus;
  if (!scanners.length) {
    status = 'unknown';
    notes.push('No engine outcome was recorded for this scan.');
  } else if (deferred.length) {
    status = 'partial';
  } else {
    status = 'complete';
  }
  return { status, scanners, exclusions, deferred, notes };
}

/** Coverage for a record that never captured any — genuinely not knowable after the fact. */
export function unknownCoverage(note: string): SecurityCoverage {
  return { status: 'unknown', scanners: [], exclusions: [], deferred: [], notes: [note] };
}

export function createBaseline(result: DvalinScanSuiteResult): SecurityBaseline {
  return {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    kind: 'dvalin-security-baseline',
    createdAt: new Date().toISOString(),
    scanId: result.id,
    scanners: result.scanners.map(scanner => scanner.id),
    coverage: deriveCoverage(result),
    findings: result.findings.map(snapshotFinding),
  };
}

export function compareWithBaseline(
  result: DvalinScanSuiteResult,
  baseline: SecurityBaseline,
  options: { suppressed?: Array<{ finding: RemediationFinding }> } = {},
): SecurityFindingDelta {
  const current = result.findings.map(snapshotFinding);
  const baselineByFingerprint = new Map(baseline.findings.map(finding => [finding.fingerprint, finding]));
  const currentFingerprints = new Set(current.map(finding => finding.fingerprint));
  const baselineTargets = new Set(baseline.findings.map(finding => finding.targetFingerprint));

  // Engines that did not complete leave a hole. A baseline finding behind that
  // hole was not looked for, so it cannot be called resolved.
  const completed = new Set(result.scanners.filter(run => run.status === 'completed').map(run => run.id));
  const attempted = new Set(result.scanners.map(run => run.id));
  const hasHole = result.scanners.some(run => run.status !== 'completed')
    || baseline.scanners.some(id => !attempted.has(id));

  const covers = (finding: SecurityFindingSnapshot): boolean => {
    if (!hasHole) return true;
    const scanner = finding.scanner ?? scannerIdForSource(finding.source);
    // Unattributable and a hole exists: we cannot claim to have looked for it.
    if (!scanner) return false;
    return completed.has(scanner);
  };

  const absent = baseline.findings.filter(finding => !currentFingerprints.has(finding.fingerprint));
  const dismissed = (options.suppressed ?? []).map(entry => snapshotFinding(entry.finding));
  const dismissedFingerprints = new Set(dismissed.map(finding => finding.fingerprint));

  const unresolved = absent.filter(finding => !dismissedFingerprints.has(finding.fingerprint));
  const added = current.filter(finding => !baselineByFingerprint.has(finding.fingerprint));

  return {
    new: added.filter(finding => !baselineTargets.has(finding.targetFingerprint)),
    existing: current.filter(finding => baselineByFingerprint.has(finding.fingerprint)),
    resolved: unresolved.filter(covers),
    // Same rule, same file, different line or wording: the target came back.
    reopened: added.filter(finding => baselineTargets.has(finding.targetFingerprint)),
    dismissed,
    unknown: unresolved.filter(finding => !covers(finding)),
  };
}

export function evaluateSecurityGate(input: {
  result: DvalinScanSuiteResult;
  threshold: SecurityThreshold;
  mode: SecurityGateMode;
  delta?: SecurityFindingDelta;
}): SecurityGateResult {
  const considered = input.mode === 'new'
    ? input.delta?.new ?? input.result.findings.map(snapshotFinding)
    : input.result.findings.map(snapshotFinding);
  const thresholdIndex = input.threshold === 'none' ? -1 : SECURITY_SEVERITIES.indexOf(input.threshold);
  const blocking = thresholdIndex === -1
    ? []
    : considered.filter(finding => SECURITY_SEVERITIES.indexOf(severityOfFinding(finding)) <= thresholdIndex);
  return {
    passed: blocking.length === 0,
    mode: input.mode,
    threshold: input.threshold,
    considered: considered.length,
    blocking,
  };
}

/** True for any schema version this build can read, not only the one it writes. */
export function isSupportedSecuritySchemaVersion(value: unknown): boolean {
  return typeof value === 'number' && SUPPORTED_SECURITY_SCHEMA_VERSIONS.includes(value);
}

export function isSecurityBaseline(value: unknown): value is SecurityBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isSupportedSecuritySchemaVersion(record.schemaVersion)
    && record.kind === 'dvalin-security-baseline'
    && typeof record.createdAt === 'string'
    && typeof record.scanId === 'string'
    && Array.isArray(record.scanners)
    && Array.isArray(record.findings)
    && record.findings.every(isFindingSnapshot);
}

function isFindingSnapshot(value: unknown): value is SecurityFindingSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.fingerprint === 'string'
    && typeof record.targetFingerprint === 'string'
    && typeof record.findingId === 'string'
    && typeof record.source === 'string'
    && typeof record.ruleId === 'string'
    && typeof record.message === 'string'
    && typeof record.path === 'string'
    && Array.isArray(record.tags);
}

function digest(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
