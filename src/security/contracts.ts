import { createHash } from 'node:crypto';
import type { RemediationFinding } from '../remediation/sarif.js';
import type { DvalinScannerId, DvalinScanSuiteResult } from '../remediation/scannerSuite.js';

export const SECURITY_SCHEMA_VERSION = 1 as const;

export const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type SecuritySeverity = typeof SECURITY_SEVERITIES[number];
export type SecurityThreshold = SecuritySeverity | 'none';
export type SecurityGateMode = 'all' | 'new';

export type SecurityFindingSnapshot = {
  fingerprint: string;
  targetFingerprint: string;
  findingId: string;
  source: string;
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
  findings: SecurityFindingSnapshot[];
};

export type SecurityFindingDelta = {
  new: SecurityFindingSnapshot[];
  existing: SecurityFindingSnapshot[];
  resolved: SecurityFindingSnapshot[];
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

export function snapshotFinding(finding: RemediationFinding): SecurityFindingSnapshot {
  return {
    fingerprint: findingFingerprint(finding),
    targetFingerprint: findingTargetFingerprint(finding),
    findingId: finding.id,
    source: finding.source,
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

export function createBaseline(result: DvalinScanSuiteResult): SecurityBaseline {
  return {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    kind: 'dvalin-security-baseline',
    createdAt: new Date().toISOString(),
    scanId: result.id,
    scanners: result.scanners.map(scanner => scanner.id),
    findings: result.findings.map(snapshotFinding),
  };
}

export function compareWithBaseline(result: DvalinScanSuiteResult, baseline: SecurityBaseline): SecurityFindingDelta {
  const current = result.findings.map(snapshotFinding);
  const baselineByFingerprint = new Map(baseline.findings.map(finding => [finding.fingerprint, finding]));
  const currentFingerprints = new Set(current.map(finding => finding.fingerprint));
  return {
    new: current.filter(finding => !baselineByFingerprint.has(finding.fingerprint)),
    existing: current.filter(finding => baselineByFingerprint.has(finding.fingerprint)),
    resolved: baseline.findings.filter(finding => !currentFingerprints.has(finding.fingerprint)),
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

export function isSecurityBaseline(value: unknown): value is SecurityBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === SECURITY_SCHEMA_VERSION
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
