import { describe, expect, it } from 'vitest';
import {
  FIX_RECORD_SCHEMA_V1,
  FIX_RECORD_SCHEMA_V2,
  blockingIntroduced,
  buildFixRecord,
  deriveFixVerdict,
  evaluateFixVerdictV1,
  fixRecordHash,
  renderFixRecord,
  verifyFixRecord,
  type FixRecordGate,
  type FixRecordInput,
  type VerifiedFixRecord,
} from '../src/security/fixRecord.js';
import type { SecurityCoverage, SecurityFindingSnapshot } from '../src/security/contracts.js';

const complete: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

function finding(overrides: Partial<SecurityFindingSnapshot> = {}): SecurityFindingSnapshot {
  return {
    fingerprint: 'fp-1',
    targetFingerprint: 'tfp-1',
    findingId: 'one',
    source: 'Dvalin Local Scan',
    scanner: 'builtin',
    ruleId: 'dvalin/eval',
    severity: 'error',
    message: 'eval on user input',
    path: 'src/app.ts',
    startLine: 4,
    tags: [],
    ...overrides,
  };
}

/** `severityOfFinding` reads `securitySeverity` first, then `severity`. */
const critical = finding({ ruleId: 'dvalin/sql-injection', securitySeverity: '9.1', fingerprint: 'fp-new' });
const low = finding({ ruleId: 'dvalin/style', severity: 'note', securitySeverity: '1.0', fingerprint: 'fp-low' });

const gate: FixRecordGate = { threshold: 'high', mode: 'new' };

function input(overrides: Partial<FixRecordInput> = {}): FixRecordInput {
  return {
    projectId: 'abc123',
    executor: 'claude-code',
    before: { scanId: 'scan-a', completedAt: '2026-01-01T00:00:00Z', coverage: complete, targets: [finding()] },
    after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: complete, remainingTargets: [] },
    checks: [{ kind: 'test', command: 'npm test', exitCode: 0, passed: true }],
    generatedAt: '2026-01-01T00:11:00Z',
    version: '0.18.0',
    ...overrides,
  };
}

/** A v2 record with the regression evidence supplied. */
function v2(introduced: SecurityFindingSnapshot[] | null, overrides: Partial<FixRecordInput> = {}) {
  return buildFixRecord(input({ regression: { gate, introduced }, ...overrides }));
}

describe('schema selection', () => {
  it('issues v1 when no regression evidence is supplied', () => {
    const record = buildFixRecord(input());
    expect(record.schema).toBe(FIX_RECORD_SCHEMA_V1);
    expect(record.after.introduced).toBeUndefined();
    expect(record.gate).toBeUndefined();
    expect(record.outcome).toBeUndefined();
  });

  it('issues v2 when it is', () => {
    const record = v2([]);
    expect(record.schema).toBe(FIX_RECORD_SCHEMA_V2);
    expect(record.after.introduced).toEqual([]);
    expect(record.gate).toEqual(gate);
    expect(record.outcome).toBe('verified');
  });
});

describe('the v2 rule', () => {
  it('verifies a repair that removed its target and introduced nothing', () => {
    const record = v2([]);
    expect(record.verdict.verified).toBe(true);
    expect(record.outcome).toBe('verified');
  });

  it('refuses a repair that introduced a finding at or above the threshold', () => {
    const record = v2([critical]);

    // The defect this version exists for. Under v1 this record said `verified`,
    // because v1 only ever asked whether the original target was gone.
    expect(record.verdict.verified).toBe(false);
    expect(record.outcome).toBe('regressed');
    expect(record.verdict.reasons.join(' ')).toContain('dvalin/sql-injection');
  });

  it('records a finding below the threshold without failing on it', () => {
    const record = v2([low]);
    expect(record.verdict.verified).toBe(true);
    // Recorded even though it does not block: a record that said nothing here
    // would read as though the change introduced nothing at all.
    expect(record.verdict.reasons.join(' ')).toContain('below high');
  });

  it('refuses when the producer did not determine what was introduced', () => {
    const record = v2(null);

    // The load-bearing case. If `null` passed, a producer that does not look
    // would get a better verdict than one that looks and finds something.
    expect(record.verdict.verified).toBe(false);
    expect(record.outcome).toBe('unverifiable');
    expect(record.verdict.reasons.join(' ')).toContain('did not determine');
  });

  it('still refuses on the v1 grounds', () => {
    const remains = v2([], { after: { scanId: 'scan-b', completedAt: 'x', coverage: complete, remainingTargets: [finding()] } });
    expect(remains.verdict.verified).toBe(false);
    expect(remains.outcome).toBe('target-remains');

    const unchecked = v2([], { checks: [] });
    expect(unchecked.verdict.verified).toBe(false);
    expect(unchecked.outcome).toBe('unverifiable');
  });

  it('treats a `none` threshold as blocking nothing', () => {
    const record = buildFixRecord(input({
      regression: { gate: { threshold: 'none', mode: 'all' }, introduced: [critical] },
    }));
    expect(record.verdict.verified).toBe(true);
    expect(blockingIntroduced([critical], { threshold: 'none', mode: 'all' })).toEqual([]);
  });

  it('keeps the complete list, not a pre-filtered one', () => {
    const record = v2([critical, low]);

    // The threshold decides what blocks; the record keeps everything so a
    // stricter reader can re-decide without re-scanning.
    expect(record.after.introduced).toHaveLength(2);
    expect(blockingIntroduced(record.after.introduced!, gate)).toEqual([critical]);
  });
});

describe('v1 records are not re-judged', () => {
  it('re-derives a v1 record under v1 rules even when v2 exists', () => {
    // A repair that introduced a critical finding, issued before v2. v1 never
    // asked, so the record says verified — and must keep verifying, or every
    // record ever issued breaks the moment the rules improve.
    const record = buildFixRecord(input());
    expect(record.schema).toBe(FIX_RECORD_SCHEMA_V1);
    expect(record.verdict.verified).toBe(true);
    expect(verifyFixRecord(record).ok).toBe(true);
  });

  it('says in the rendering that v1 did not evaluate regressions', () => {
    const text = renderFixRecord(buildFixRecord(input()));
    expect(text).toContain('issued under v1 rules');
    expect(text).not.toContain('introduced:');
  });

  it('shows the regression evidence for a v2 record', () => {
    const text = renderFixRecord(v2([critical]));
    expect(text).toContain('introduced: 1');
    expect(text).toContain('gate high/new');
    expect(text).toContain('outcome: regressed');
  });

  it('derives each schema under its own rule', () => {
    const asV1 = buildFixRecord(input());
    const asV2 = v2(null);
    expect(deriveFixVerdict(asV1).verified).toBe(true);
    expect(deriveFixVerdict(asV2).verified).toBe(false);
    // Same evidence, different rule — which is exactly what versioning buys.
    expect(evaluateFixVerdictV1({
      checks: asV2.checks,
      remainingTargets: asV2.after.remainingTargets,
      beforeCoverage: asV2.before.coverage,
      afterCoverage: asV2.after.coverage,
    }).verified).toBe(true);
  });
});

describe('verification of v2 records', () => {
  it('accepts a well-formed record', () => {
    const check = verifyFixRecord(v2([]));
    expect(check.ok).toBe(true);
    expect(check.reasons).toEqual([]);
  });

  it('catches a verdict edited to disagree with the record’s own evidence', () => {
    const record = v2([critical]) as VerifiedFixRecord;
    const tampered = { ...record, verdict: { verified: true, reasons: [] } };
    const rehashed = { ...tampered, recordHash: fixRecordHash(tampered) };

    // The hash is consistent, so only re-deriving the verdict catches this.
    const check = verifyFixRecord(rehashed);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toContain('verdict does not follow');
  });

  it('catches an outcome edited away from its evidence', () => {
    const record = v2([critical]);
    const tampered = { ...record, outcome: 'verified' as const, verdict: record.verdict };
    const rehashed = { ...tampered, recordHash: fixRecordHash(tampered) };

    const check = verifyFixRecord(rehashed);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toContain('outcome does not follow');
  });

  it('rejects a v2 record whose gate was stripped', () => {
    const record = v2([]);
    const { gate: _dropped, ...withoutGate } = record;
    const rehashed = { ...withoutGate, recordHash: fixRecordHash(withoutGate as VerifiedFixRecord) };

    // Malformed rather than merely undetermined: v2's rule cannot be
    // re-derived without the gate, and "not determined" has to be written
    // down deliberately as `introduced: null`.
    expect(verifyFixRecord(rehashed).ok).toBe(false);
    expect(verifyFixRecord(rehashed).reasons.join(' ')).toContain('unsupported schema version');
  });

  it('rejects a v2 record missing the introduced field entirely', () => {
    const record = v2([]);
    const stripped = {
      ...record,
      after: { scanId: record.after.scanId, completedAt: record.after.completedAt, coverage: record.after.coverage, remainingTargets: record.after.remainingTargets },
    };
    const rehashed = { ...stripped, recordHash: fixRecordHash(stripped as VerifiedFixRecord) };

    expect(verifyFixRecord(rehashed).ok).toBe(false);
  });

  it('rejects an unknown schema version outright', () => {
    const record = { ...v2([]), schema: 'dvalin-fix-record/v3' };
    expect(verifyFixRecord(record).ok).toBe(false);
  });
});
