import { canonicalJSON, sha256 } from '../audit/hash.js';
import { VERSION } from '../version.js';
import {
  SECURITY_COVERAGE_STATUSES,
  SECURITY_SEVERITIES,
  severityOfFinding,
  type SecurityCoverage,
  type SecurityFindingSnapshot,
  type SecurityGateMode,
  type SecurityThreshold,
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
export const FIX_RECORD_SCHEMA_V1 = 'dvalin-fix-record/v1';
export const FIX_RECORD_SCHEMA_V2 = 'dvalin-fix-record/v2';

/**
 * Both are readable; v2 is what new records say.
 *
 * v1 asked one question — "is the target gone, and did the checks pass?" — and
 * left "did this change introduce something new?" to whichever command happened
 * to be producing the record. Two producers answered it differently, so the
 * same record contents meant two different things depending on who wrote them.
 * v2 puts that question, and the threshold used to answer it, inside the record.
 *
 * v1 records keep verifying under v1 rules, permanently. A record that stops
 * re-deriving because the rules moved under it would break the one promise this
 * format makes; a bug in the rules is not a reason to spend that.
 */
export const SUPPORTED_FIX_RECORD_SCHEMAS = [FIX_RECORD_SCHEMA_V1, FIX_RECORD_SCHEMA_V2] as const;
export type FixRecordSchema = typeof SUPPORTED_FIX_RECORD_SCHEMAS[number];

/** @deprecated Read `record.schema`; write with `FIX_RECORD_SCHEMA_V2`. */
export const FIX_RECORD_SCHEMA = FIX_RECORD_SCHEMA_V1;

export const FIX_EXECUTORS = ['dvalin', 'codex', 'claude-code', 'copilot', 'human', 'unknown'] as const;
export type FixExecutor = typeof FIX_EXECUTORS[number];

/**
 * The rule the verdict was reached under, carried so it can be reached again.
 *
 * Without this a third party re-deriving the record has to guess which
 * threshold applied — which is the same gap that let two producers disagree.
 */
export type FixRecordGate = { threshold: SecurityThreshold; mode: SecurityGateMode };

/**
 * What happened, beyond the boolean.
 *
 * `verified` stays a boolean because every consumer already branches on it.
 * This says which of the three ways a repair can fall short actually occurred,
 * so a machine reader does not have to parse `reasons` prose to find out.
 */
export const FIX_RECORD_OUTCOMES = ['verified', 'target-remains', 'regressed', 'unverifiable'] as const;
export type FixRecordOutcome = typeof FIX_RECORD_OUTCOMES[number];

export type FixRecordScan = {
  scanId: string;
  completedAt: string;
  coverage: SecurityCoverage;
};

export type VerifiedFixRecord = {
  schema: FixRecordSchema;
  generatedAt: string;
  tool: { name: 'dvalincode'; version: string };
  workflowId?: string;
  projectId: string;
  /** Who edited the code. Recorded, never consulted. */
  executor: FixExecutor;
  before: FixRecordScan & { targets: SecurityFindingSnapshot[] };
  after: FixRecordScan & {
    /** Findings from `before.targets` that the re-scan still sees. */
    remainingTargets: SecurityFindingSnapshot[];
    /**
     * Findings the re-scan sees that the original scan did not — the repair's
     * own side effects. **v2 only.**
     *
     * Three states, and the third is the point. `[]` means it was looked for
     * and there was none; a non-empty list is what was found; `null` means it
     * was not determined. `null` cannot verify, for the same reason an empty
     * `checks` list cannot: absent because unlooked-for is not absent.
     *
     * The list is complete, not pre-filtered by severity. The threshold in
     * `gate` decides what blocks, so a stricter reader can re-decide from the
     * same evidence rather than having to re-scan. Recording the observation
     * and deriving the judgement is the same rule this format already applies
     * to exit codes.
     */
    introduced?: SecurityFindingSnapshot[] | null;
  };
  /** The rule the verdict was reached under. **v2 only.** */
  gate?: FixRecordGate;
  /** Which way the repair fell short, when it did. **v2 only.** */
  outcome?: FixRecordOutcome;
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
  /**
   * Supplying this issues a v2 record; omitting it issues v1.
   *
   * `introduced: null` is a legitimate value and says the producer did not
   * determine it — which v2 treats as unverifiable rather than as clean.
   */
  regression?: { gate: FixRecordGate; introduced: SecurityFindingSnapshot[] | null };
  changes?: { files: string[]; diffHash: string };
  checks: SecurityCheckEvidence[];
  audit?: { runId: string; headHash: string };
  policyHash?: string;
  generatedAt?: string;
  version?: string;
};

/** Findings from `introduced` that meet or exceed the gate's threshold. */
export function blockingIntroduced(
  introduced: SecurityFindingSnapshot[],
  gate: FixRecordGate,
): SecurityFindingSnapshot[] {
  if (gate.threshold === 'none') return [];
  const limit = SECURITY_SEVERITIES.indexOf(gate.threshold);
  return introduced.filter(finding => SECURITY_SEVERITIES.indexOf(severityOfFinding(finding)) <= limit);
}

/**
 * The v1 rule, frozen.
 *
 * Every record ever issued under v1 was hashed with a verdict this function
 * produced, and `verifyFixRecord` re-derives and compares. Changing it would
 * retroactively invalidate all of them, so it does not change — not to fix the
 * gap v2 exists to fix, not for anything. New rules go in a new version.
 */
export function evaluateFixVerdictV1(input: {
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

/**
 * The v2 rule: v1, plus the question v1 left to its callers.
 *
 * A repair is a change, and a change does two things — it removes what it was
 * aimed at, and it may add something that was not there. v1 only asked the
 * first. That was survivable while one producer answered the second on the
 * side, and stopped being survivable when a second producer answered it
 * differently.
 *
 * `introduced: null` fails. The alternative is that a producer which does not
 * look gets a better verdict than one which looks and finds something, and a
 * rule that rewards not looking is not a rule.
 */
export function evaluateFixVerdictV2(input: {
  checks: SecurityCheckEvidence[];
  remainingTargets: SecurityFindingSnapshot[];
  introduced: SecurityFindingSnapshot[] | null | undefined;
  gate: FixRecordGate | undefined;
  beforeCoverage: SecurityCoverage;
  afterCoverage: SecurityCoverage;
}): { verified: boolean; reasons: string[]; outcome: FixRecordOutcome } {
  const base = evaluateFixVerdictV1({
    checks: input.checks,
    remainingTargets: input.remainingTargets,
    beforeCoverage: input.beforeCoverage,
    afterCoverage: input.afterCoverage,
  });

  const reasons: string[] = [];
  // Tracked as flags rather than read back out of the prose, so that what
  // blocks a verdict never depends on how a sentence was worded.
  let regressed = false;
  let undetermined = false;

  if (!input.gate) {
    undetermined = true;
    reasons.push('the record carries no gate, so the rule its verdict was reached under cannot be re-derived');
  } else if (input.introduced === null || input.introduced === undefined) {
    undetermined = true;
    reasons.push('the verifying scan did not determine whether the repair introduced new findings');
  } else {
    const blocking = blockingIntroduced(input.introduced, input.gate);
    if (blocking.length) {
      regressed = true;
      reasons.push(
        `the repair introduced ${blocking.length} finding(s) at or above ${input.gate.threshold}: ${blocking.map(finding => finding.ruleId).join(', ')}`,
      );
    } else if (input.introduced.length) {
      // Below the threshold: recorded, not blocking. Saying so keeps the record
      // from reading as though the change introduced nothing at all.
      reasons.push(`the repair introduced ${input.introduced.length} finding(s) below ${input.gate.threshold}`);
    }
  }

  const verified = base.verified && !regressed && !undetermined;
  const outcome: FixRecordOutcome = verified
    ? 'verified'
    : regressed
      ? 'regressed'
      : input.remainingTargets.length
        ? 'target-remains'
        : 'unverifiable';

  return { verified, reasons: [...base.reasons, ...reasons], outcome };
}

/**
 * Re-derive a record's verdict under the rules of its own schema version.
 *
 * The single place that decides which rule applies. A caller that picked the
 * rule itself would be back to producers disagreeing about what a record means.
 */
export function deriveFixVerdict(
  record: Pick<VerifiedFixRecord, 'schema' | 'checks' | 'before' | 'after' | 'gate'>,
): { verified: boolean; reasons: string[]; outcome?: FixRecordOutcome } {
  if (record.schema === FIX_RECORD_SCHEMA_V2) {
    return evaluateFixVerdictV2({
      checks: record.checks,
      remainingTargets: record.after.remainingTargets,
      introduced: record.after.introduced,
      gate: record.gate,
      beforeCoverage: record.before.coverage,
      afterCoverage: record.after.coverage,
    });
  }
  return evaluateFixVerdictV1({
    checks: record.checks,
    remainingTargets: record.after.remainingTargets,
    beforeCoverage: record.before.coverage,
    afterCoverage: record.after.coverage,
  });
}

export function buildFixRecord(input: FixRecordInput): VerifiedFixRecord {
  const schema = input.regression ? FIX_RECORD_SCHEMA_V2 : FIX_RECORD_SCHEMA_V1;
  const after = input.regression
    ? { ...input.after, introduced: input.regression.introduced }
    : input.after;

  const verdict = deriveFixVerdict({
    schema,
    checks: input.checks,
    before: input.before,
    after,
    gate: input.regression?.gate,
  });

  const record: Omit<VerifiedFixRecord, 'recordHash'> = {
    schema,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tool: { name: 'dvalincode', version: input.version ?? VERSION },
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    projectId: input.projectId,
    executor: input.executor ?? 'unknown',
    before: input.before,
    after,
    ...(input.regression ? { gate: input.regression.gate } : {}),
    ...(verdict.outcome ? { outcome: verdict.outcome } : {}),
    ...(input.changes ? { changes: input.changes } : {}),
    checks: input.checks,
    assurance: input.checks.length ? 'scan-and-checks' : 'scan-only',
    verdict: { verified: verdict.verified, reasons: verdict.reasons },
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
  //
  // Under the rules of the record's own schema version, never the newest ones:
  // a v1 record re-derives to what v1 said, permanently.
  const derived = deriveFixVerdict(record);
  if (derived.verified !== record.verdict.verified) {
    reasons.push(`verdict does not follow from the record's own evidence: stored ${record.verdict.verified}, derived ${derived.verified}`);
  }
  if (derived.outcome && record.outcome && derived.outcome !== record.outcome) {
    reasons.push(`outcome does not follow from the record's own evidence: stored ${record.outcome}, derived ${derived.outcome}`);
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
  if (record.schema === FIX_RECORD_SCHEMA_V2) {
    const introduced = record.after.introduced;
    lines.push(`  introduced: ${introduced === null || introduced === undefined ? 'not determined' : `${introduced.length}`}`
      + (record.gate ? ` (gate ${record.gate.threshold}/${record.gate.mode})` : ''));
    if (record.outcome) lines.push(`  outcome: ${record.outcome}`);
  } else {
    // Not a caveat about this repair — a caveat about the rules it was judged
    // under. A reader comparing a v1 and a v2 record must not read them as
    // having answered the same question.
    lines.push('  note: issued under v1 rules — whether the repair introduced new findings was not evaluated');
  }
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
  if (!SUPPORTED_FIX_RECORD_SCHEMAS.includes(record.schema as FixRecordSchema)) return false;
  if (record.schema === FIX_RECORD_SCHEMA_V2 && !isV2Shape(record)) return false;
  return typeof record.generatedAt === 'string'
    && typeof record.projectId === 'string'
    && typeof record.recordHash === 'string'
    && (record.assurance === 'scan-only' || record.assurance === 'scan-and-checks')
    && FIX_EXECUTORS.includes(record.executor as FixExecutor)
    && Array.isArray(record.checks)
    && isVerdict(record.verdict)
    && isScanSide(record.before, 'targets')
    && isScanSide(record.after, 'remainingTargets');
}

/**
 * The fields v2 adds, required because v2's rule cannot be re-derived without
 * them. A v2 record missing them is malformed, not merely undetermined — the
 * `null` that means "not determined" has to be written down deliberately.
 */
function isV2Shape(record: Record<string, unknown>): boolean {
  const after = record.after as Record<string, unknown> | undefined;
  if (!after) return false;
  const introduced = after.introduced;
  if (introduced !== null && !Array.isArray(introduced)) return false;

  const gate = record.gate as Record<string, unknown> | undefined;
  if (!gate) return false;
  const thresholdOk = gate.threshold === 'none'
    || SECURITY_SEVERITIES.includes(gate.threshold as typeof SECURITY_SEVERITIES[number]);
  if (!thresholdOk) return false;
  if (gate.mode !== 'all' && gate.mode !== 'new') return false;

  return record.outcome === undefined || FIX_RECORD_OUTCOMES.includes(record.outcome as FixRecordOutcome);
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
