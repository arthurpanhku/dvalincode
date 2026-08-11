import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dvalinHome } from '../memory/store.js';
import {
  DVALIN_SCANNER_IDS,
  type DvalinScannerId,
  type DvalinScanMetrics,
  type DvalinScanSuiteResult,
} from '../remediation/scannerSuite.js';
import { UsageError } from '../core/exitCodes.js';
import {
  SECURITY_SCHEMA_VERSION,
  SECURITY_SEVERITIES,
  severityOfFinding,
  snapshotFinding,
  type SecurityFindingDelta,
  type SecurityFindingSnapshot,
  type SecurityGateResult,
} from './contracts.js';

export type SecurityWorkflowState =
  | 'created'
  | 'scanning'
  | 'ready'
  | 'external_handoff'
  | 'internal_fix'
  | 'verifying'
  | 'passed'
  | 'needs_work'
  | 'blocked'
  | 'evidence_ready'
  | 'publication_pending'
  | 'published';

const SECURITY_WORKFLOW_STATES: SecurityWorkflowState[] = [
  'created', 'scanning', 'ready', 'external_handoff', 'internal_fix', 'verifying',
  'passed', 'needs_work', 'blocked', 'evidence_ready', 'publication_pending', 'published',
];

export type SecurityCheckEvidence = {
  kind: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
};

export type SecurityWorkflowScan = {
  id: string;
  completedAt: string;
  score: number;
  grade: DvalinScanSuiteResult['grade'];
  metrics: DvalinScanMetrics;
  findings: SecurityFindingSnapshot[];
};

export type SecurityWorkflow = {
  schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  kind: 'dvalin-security-workflow';
  id: string;
  projectId: string;
  root: string;
  state: SecurityWorkflowState;
  scanners: DvalinScannerId[];
  createdAt: string;
  updatedAt: string;
  initialScan: SecurityWorkflowScan;
  latestScan: SecurityWorkflowScan;
  delta?: SecurityFindingDelta;
  gate: SecurityGateResult;
  verification?: {
    assurance: 'scan-only' | 'scan-and-checks';
    checks: SecurityCheckEvidence[];
    verifiedAt: string;
  };
  history: Array<{ state: SecurityWorkflowState; at: string; note?: string }>;
};

const TRANSITIONS: Record<SecurityWorkflowState, SecurityWorkflowState[]> = {
  created: ['scanning', 'blocked'],
  scanning: ['ready', 'passed', 'needs_work', 'blocked'],
  ready: ['external_handoff', 'internal_fix', 'verifying', 'needs_work', 'blocked'],
  external_handoff: ['verifying', 'blocked'],
  internal_fix: ['verifying', 'blocked'],
  verifying: ['passed', 'needs_work', 'blocked'],
  passed: ['evidence_ready', 'publication_pending', 'published', 'verifying'],
  needs_work: ['external_handoff', 'internal_fix', 'verifying', 'blocked'],
  blocked: ['scanning', 'verifying'],
  evidence_ready: ['publication_pending', 'published', 'verifying'],
  publication_pending: ['published', 'blocked'],
  published: ['verifying'],
};

export async function createSecurityWorkflow(input: {
  root: string;
  result: DvalinScanSuiteResult;
  gate: SecurityGateResult;
  delta?: SecurityFindingDelta;
}): Promise<SecurityWorkflow> {
  const now = new Date().toISOString();
  const root = path.resolve(input.root);
  const initialScan = workflowScan(input.result);
  const state: SecurityWorkflowState = input.gate.passed ? 'passed' : 'needs_work';
  const workflow: SecurityWorkflow = {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    kind: 'dvalin-security-workflow',
    id: `security-${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
    projectId: createHash('sha256').update(root).digest('hex').slice(0, 16),
    root,
    state,
    scanners: input.result.scanners.map(scanner => scanner.id),
    createdAt: now,
    updatedAt: now,
    initialScan,
    latestScan: initialScan,
    delta: input.delta,
    gate: input.gate,
    history: [
      { state: 'created', at: now },
      { state: 'scanning', at: now },
      { state, at: now, note: input.gate.passed ? 'Security gate passed.' : 'Security gate needs remediation.' },
    ],
  };
  await persistSecurityWorkflow(workflow);
  return workflow;
}

export async function loadSecurityWorkflow(id: string): Promise<SecurityWorkflow> {
  assertWorkflowId(id);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(workflowPath(id), 'utf8')) as unknown;
  } catch (error) {
    throw new UsageError(`Cannot read security workflow ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isSecurityWorkflow(value) || value.id !== id) throw new UsageError(`Invalid or unsupported security workflow: ${id}`);
  return value;
}

export async function transitionSecurityWorkflow(
  workflow: SecurityWorkflow,
  next: SecurityWorkflowState,
  note?: string,
): Promise<SecurityWorkflow> {
  if (workflow.state !== next && !TRANSITIONS[workflow.state].includes(next)) {
    throw new UsageError(`Invalid security workflow transition: ${workflow.state} -> ${next}`);
  }
  const at = new Date().toISOString();
  const updated: SecurityWorkflow = {
    ...workflow,
    state: next,
    updatedAt: at,
    history: [...workflow.history, { state: next, at, ...(note ? { note } : {}) }],
  };
  await persistSecurityWorkflow(updated);
  return updated;
}

export async function verifySecurityWorkflow(input: {
  workflow: SecurityWorkflow;
  result: DvalinScanSuiteResult;
  gate: SecurityGateResult;
  checks?: SecurityCheckEvidence[];
}): Promise<SecurityWorkflow> {
  let workflow = input.workflow;
  if (workflow.state !== 'verifying') workflow = await transitionSecurityWorkflow(workflow, 'verifying');
  const checks = input.checks ?? [];
  const checksPassed = checks.every(check => check.passed);
  const passed = input.gate.passed && checksPassed;
  const at = new Date().toISOString();
  const next: SecurityWorkflowState = passed ? 'passed' : 'needs_work';
  const updated: SecurityWorkflow = {
    ...workflow,
    state: next,
    updatedAt: at,
    latestScan: workflowScan(input.result),
    gate: input.gate,
    verification: {
      assurance: checks.length ? 'scan-and-checks' : 'scan-only',
      checks,
      verifiedAt: at,
    },
    history: [
      ...workflow.history,
      { state: next, at, note: passed ? 'Deterministic verification passed.' : 'Deterministic verification failed.' },
    ],
  };
  await persistSecurityWorkflow(updated);
  return updated;
}

export function getWorkflowFinding(workflow: SecurityWorkflow, fingerprint: string): SecurityFindingSnapshot | undefined {
  return workflow.latestScan.findings.find(finding => finding.fingerprint === fingerprint)
    ?? workflow.initialScan.findings.find(finding => finding.fingerprint === fingerprint);
}

/** Re-check the original blocked targets and reject newly introduced severe findings. */
export function evaluateWorkflowVerificationGate(
  workflow: SecurityWorkflow,
  result: DvalinScanSuiteResult,
): SecurityGateResult {
  if (workflow.gate.threshold === 'none') {
    return { passed: true, mode: workflow.gate.mode, threshold: 'none', considered: result.findings.length, blocking: [] };
  }
  const current = result.findings.map(snapshotFinding);
  const originalTargets = new Set(workflow.gate.blocking.map(finding => finding.targetFingerprint));
  const initialFingerprints = new Set(workflow.initialScan.findings.map(finding => finding.fingerprint));
  const thresholdIndex = SECURITY_SEVERITIES.indexOf(workflow.gate.threshold);
  const blocking = current.filter(finding => {
    if (originalTargets.has(finding.targetFingerprint)) return true;
    return !initialFingerprints.has(finding.fingerprint)
      && SECURITY_SEVERITIES.indexOf(severityOfFinding(finding)) <= thresholdIndex;
  });
  return {
    passed: blocking.length === 0,
    mode: workflow.gate.mode,
    threshold: workflow.gate.threshold,
    considered: current.length,
    blocking,
  };
}

function workflowScan(result: DvalinScanSuiteResult): SecurityWorkflowScan {
  return {
    id: result.id,
    completedAt: result.completedAt,
    score: result.score,
    grade: result.grade,
    metrics: { ...result.metrics },
    findings: result.findings.map(snapshotFinding),
  };
}

async function persistSecurityWorkflow(workflow: SecurityWorkflow): Promise<void> {
  const directory = workflowDirectory();
  await mkdir(directory, { recursive: true });
  const target = workflowPath(workflow.id);
  const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(workflow, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

function workflowDirectory(): string {
  return path.join(dvalinHome(), 'security', 'workflows');
}

function workflowPath(id: string): string {
  assertWorkflowId(id);
  return path.join(workflowDirectory(), `${id}.json`);
}

function assertWorkflowId(id: string): void {
  if (!/^security-[A-Za-z0-9-]+$/.test(id)) throw new UsageError(`Invalid security workflow id: ${id}`);
}

function isSecurityWorkflow(value: unknown): value is SecurityWorkflow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === SECURITY_SCHEMA_VERSION
    && record.kind === 'dvalin-security-workflow'
    && typeof record.id === 'string'
    && typeof record.projectId === 'string'
    && typeof record.root === 'string'
    && SECURITY_WORKFLOW_STATES.includes(record.state as SecurityWorkflowState)
    && Array.isArray(record.scanners)
    && record.scanners.length > 0
    && record.scanners.every(scanner => DVALIN_SCANNER_IDS.includes(scanner as DvalinScannerId))
    && Array.isArray(record.history)
    && record.history.every(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const history = entry as Record<string, unknown>;
      return SECURITY_WORKFLOW_STATES.includes(history.state as SecurityWorkflowState) && typeof history.at === 'string';
    })
    && isWorkflowScan(record.initialScan)
    && isWorkflowScan(record.latestScan)
    && isWorkflowGate(record.gate);
}

function isWorkflowScan(value: unknown): value is SecurityWorkflowScan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const scan = value as Record<string, unknown>;
  return typeof scan.id === 'string'
    && typeof scan.completedAt === 'string'
    && typeof scan.score === 'number'
    && ['A', 'B', 'C', 'D', 'F'].includes(String(scan.grade))
    && !!scan.metrics
    && Array.isArray(scan.findings)
    && scan.findings.every(finding => {
      if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false;
      const snapshot = finding as Record<string, unknown>;
      return typeof snapshot.fingerprint === 'string'
        && typeof snapshot.targetFingerprint === 'string'
        && typeof snapshot.ruleId === 'string'
        && typeof snapshot.path === 'string';
    });
}

function isWorkflowGate(value: unknown): value is SecurityGateResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const gate = value as Record<string, unknown>;
  return typeof gate.passed === 'boolean'
    && (gate.mode === 'all' || gate.mode === 'new')
    && ['critical', 'high', 'medium', 'low', 'none'].includes(String(gate.threshold))
    && typeof gate.considered === 'number'
    && Array.isArray(gate.blocking);
}
