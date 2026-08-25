import { canonicalJSON, sha256 } from '../audit/hash.js';
import { VERSION } from '../version.js';
import {
  SECURITY_COVERAGE_STATUSES,
  type SecurityCoverage,
  type SecurityFindingSnapshot,
} from './contracts.js';
import type { SecurityCheckEvidence } from './workflow.js';

/**
 * A Verified Fix Record.
 *
 * Every other tool in this space asks the model that wrote the patch whether
 * the patch is good. This records the opposite arrangement: who proposed the
 * change is metadata, and the verdict rests on exit codes Dvalin observed and a
 * re-scan Dvalin ran. That is what makes the record worth re-deriving, and what
 * lets it describe a repair produced by any agent, or by a person.
 *
 * What it proves is narrow, and the narrowness is the point: *this finding is
 * gone from this scan, and these checks were observed to pass.* It is not a
 * statement that the code is free of vulnerabilities, and nothing in this
 * module may be extended to imply that.
 */
export const FIX_RECORD_SCHEMA = 'dvalin-fix-record/v1';

export const FIX_EXECUTORS = ['dvalin', 'codex', 'claude-code', 'copilot', 'human', 'unknown'] as const;
export type FixExecutor = typeof FIX_EXECUTORS[number];

export type FixRecordScan = {
  scanId: string;
  completedAt: string;
  coverage: SecurityCoverage;
};

export type VerifiedFixRecord = {
  schema: typeof FIX_RECORD_SCHEMA;
  generatedAt: string;
  tool: { name: 'dvalincode'; version: string };
  workflowId?: string;
  projectId: string;
  /** Who edited the code. Recorded, never consulted. */
  executor: FixExecutor;
  before: FixRecordScan & { targets: SecurityFindingSnapshot[] };
  after: FixRecordScan & { remainingTargets: SecurityFindingSnapshot[] };
  changes?: { files: string[]; diffHash: string };
  /** Commands Dvalin ran itself, with the exit codes it observed. */
  checks: SecurityCheckEvidence[];
  assurance: 'scan-only' | 'scan-and-checks';
  verdict: { verified: boolean; reasons: string[] };
  /** Where in the hash-chained audit log this verification lives. */
  audit?: { runId: string; headHash: string };
  policyHash?: string;
  /**
   * Reserved. v1 records are tamper-*evident* (anyone can re-derive the hash),
   * not signed — signing proves who issued a record, which is a separate
   * question needing key custody this format does not yet define.
   */
  signatures?: never[];
  recordHash: string;
};

export type FixRecordInput = {
  workflowId?: string;
  projectId: string;
  executor?: FixExecutor;
  before: FixRecordScan & { targets: SecurityFindingSnapshot[] };
  after: FixRecordScan & { remainingTargets: SecurityFindingSnapshot[] };
  changes?: { files: string[]; diffHash: string };
  checks: SecurityCheckEvidence[];
  audit?: { runId: string; headHash: string };
  policyHash?: string;
  generatedAt?: string;
  version?: string;
};

/**
 * Decide the verdict here and nowhere else.
 *
 * Three callers produce these records; if each applied its own reading of
 * "verified" the word would mean three things. The rules live in one function
 * so that a record from the CLI, the MCP server, and the fix pipeline all mean
 * the same thing.
 */
export function evaluateFixVerdict(input: {
  checks: SecurityCheckEvidence[];
  remainingTargets: SecurityFindingSnapshot[];
  beforeCoverage: SecurityCoverage;
  afterCoverage: SecurityCoverage;
}): { verified: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (input.remainingTargets.length) {
    reasons.push(`${input.remainingTargets.length} original finding target(s) still present after the re-scan`);
  }
  if (!input.checks.length) {
    // Matches the rule the verifier already applies: a project whose checks
    // cannot be run has not demonstrated anything, so it does not pass by default.
    reasons.push('no project check could be run, so the repair is unverifiable');
  }
  const failed = input.checks.filter(check => !check.passed);
  if (failed.length) {
    reasons.push(`${failed.length} observed check(s) failed: ${failed.map(check => check.kind).join(', ')}`);
  }

  // A caveat, not a failure. Partial coverage does not make a passing check
  // false — it bounds what the record is entitled to claim, and saying so is
  // the difference between evidence and a badge.
  const caveats: string[] = [];
  if (input.afterCoverage.status !== 'complete') {
    caveats.push(`the verifying scan's coverage is ${input.afterCoverage.status}, so this record covers only what was scanned`);
  }
  if (input.beforeCoverage.status !== 'complete') {
    caveats.push(`the original scan's coverage was ${input.beforeCoverage.status}`);
  }

  return { verified: reasons.length === 0, reasons: [...reasons, ...caveats] };
}

export function buildFixRecord(input: FixRecordInput): VerifiedFixRecord {
  const verdict = evaluateFixVerdict({
    checks: input.checks,
    remainingTargets: input.after.remainingTargets,
    beforeCoverage: input.before.coverage,
    afterCoverage: input.after.coverage,
  });

  const record: Omit<VerifiedFixRecord, 'recordHash'> = {
    schema: FIX_RECORD_SCHEMA,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tool: { name: 'dvalincode', version: input.version ?? VERSION },
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    projectId: input.projectId,
    executor: input.executor ?? 'unknown',
    before: input.before,
    after: input.after,
    ...(input.changes ? { changes: input.changes } : {}),
    checks: input.checks,
    assurance: input.checks.length ? 'scan-and-checks' : 'scan-only',
    verdict,
    ...(input.audit ? { audit: input.audit } : {}),
    ...(input.policyHash ? { policyHash: input.policyHash } : {}),
  };

  return { ...record, recordHash: fixRecordHash(record) };
}

/** Hash of everything except the hash itself, over canonical JSON so key order cannot change it. */
export function fixRecordHash(record: Omit<VerifiedFixRecord, 'recordHash'> | VerifiedFixRecord): string {
  const { recordHash: _ignored, ...rest } = record as VerifiedFixRecord;
  return sha256(canonicalJSON(rest));
}

export type FixRecordVerification = {
  ok: boolean;
  reasons: string[];
  record?: VerifiedFixRecord;
};

/**
 * Re-derive a record offline.
 *
 * Needs no workspace, no network, and no Dvalin state — that is the property
 * that lets a reviewer who trusts none of the above check the record anyway.
 * It answers "is this record internally sound and unmodified", not "is the
 * repair still good"; re-running the scanners is a separate, explicit step.
 */
export function verifyFixRecord(value: unknown): FixRecordVerification {
  if (!isFixRecordShape(value)) {
    return { ok: false, reasons: ['Not a Dvalin fix record, or written by an unsupported schema version.'] };
  }
  const record = value;
  const reasons: string[] = [];

  const expected = fixRecordHash(record);
  if (expected !== record.recordHash) {
    reasons.push(`recordHash mismatch: the record has been modified since it was issued (expected ${expected}, found ${record.recordHash})`);
  }

  // The verdict is derived, so a record whose stored verdict disagrees with its
  // own evidence has been edited in a way the hash alone would catch only if
  // the hash were left stale. Recomputing it closes that door.
  const derived = evaluateFixVerdict({
    checks: record.checks,
    remainingTargets: record.after.remainingTargets,
    beforeCoverage: record.before.coverage,
    afterCoverage: record.after.coverage,
  });
  if (derived.verified !== record.verdict.verified) {
    reasons.push(`verdict does not follow from the record's own evidence: stored ${record.verdict.verified}, derived ${derived.verified}`);
  }

  const expectedAssurance = record.checks.length ? 'scan-and-checks' : 'scan-only';
  if (record.assurance !== expectedAssurance) {
    reasons.push(`assurance says ${record.assurance} but the record carries ${record.checks.length} check(s)`);
  }

  return { ok: reasons.length === 0, reasons, record };
}

/** One-line summary for a terminal or a pull-request comment. */
export function renderFixRecord(record: VerifiedFixRecord): string {
  const lines = [
    `Fix record ${record.recordHash.slice(0, 12)} · ${record.verdict.verified ? 'VERIFIED' : 'NOT VERIFIED'} · ${record.assurance}`,
    `  executor: ${record.executor} (recorded, not consulted)`,
    `  targets: ${record.before.targets.length} before · ${record.after.remainingTargets.length} remaining`,
    `  coverage: ${record.before.coverage.status} → ${record.after.coverage.status}`,
  ];
  for (const check of record.checks) {
    lines.push(`  ${check.passed ? '✓' : '✗'} ${check.kind}: ${check.command}${check.exitCode === null ? '' : ` (exit ${check.exitCode})`}`);
  }
  for (const reason of record.verdict.reasons) lines.push(`  · ${reason}`);
  if (record.audit) lines.push(`  audit: run ${record.audit.runId} @ ${record.audit.headHash.slice(0, 12)}`);
  return lines.join('\n');
}

function isFixRecordShape(value: unknown): value is VerifiedFixRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema === FIX_RECORD_SCHEMA
    && typeof record.generatedAt === 'string'
    && typeof record.projectId === 'string'
    && typeof record.recordHash === 'string'
    && (record.assurance === 'scan-only' || record.assurance === 'scan-and-checks')
    && FIX_EXECUTORS.includes(record.executor as FixExecutor)
    && Array.isArray(record.checks)
    && isVerdict(record.verdict)
    && isScanSide(record.before, 'targets')
    && isScanSide(record.after, 'remainingTargets');
}

function isVerdict(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const verdict = value as Record<string, unknown>;
  return typeof verdict.verified === 'boolean' && Array.isArray(verdict.reasons);
}

function isScanSide(value: unknown, findingsKey: 'targets' | 'remainingTargets'): boolean {
  if (!value || typeof value !== 'object') return false;
  const side = value as Record<string, unknown>;
  const coverage = side.coverage as Record<string, unknown> | undefined;
  return typeof side.scanId === 'string'
    && typeof side.completedAt === 'string'
    && !!coverage
    && SECURITY_COVERAGE_STATUSES.includes(coverage.status as SecurityCoverage['status'])
    && Array.isArray(side[findingsKey]);
}
