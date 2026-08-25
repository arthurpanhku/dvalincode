import { describe, expect, it } from 'vitest';
import {
  FIX_RECORD_SCHEMA,
  buildFixRecord,
  evaluateFixVerdict,
  fixRecordHash,
  renderFixRecord,
  verifyFixRecord,
  type FixRecordInput,
} from '../src/security/fixRecord.js';
import type { SecurityCoverage, SecurityFindingSnapshot } from '../src/security/contracts.js';

const complete: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

const partial: SecurityCoverage = {
  ...complete,
  status: 'partial',
  scanners: [{ id: 'builtin', status: 'completed' }, { id: 'semgrep', status: 'missing' }],
  deferred: ['Semgrep CE: missing'],
};

const target: SecurityFindingSnapshot = {
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
};

function input(overrides: Partial<FixRecordInput> = {}): FixRecordInput {
  return {
    projectId: 'abc123',
    executor: 'claude-code',
    before: { scanId: 'scan-a', completedAt: '2026-01-01T00:00:00Z', coverage: complete, targets: [target] },
    after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: complete, remainingTargets: [] },
    checks: [{ kind: 'test', command: 'npm test', exitCode: 0, passed: true }],
    generatedAt: '2026-01-01T00:11:00Z',
    version: '0.18.0',
    ...overrides,
  };
}

describe('fix record hashing', () => {
  it('is stable and independent of key order', () => {
    const record = buildFixRecord(input());
    const reordered = JSON.parse(JSON.stringify({
      recordHash: record.recordHash,
      verdict: record.verdict,
      after: record.after,
      before: record.before,
      schema: record.schema,
      checks: record.checks,
      assurance: record.assurance,
      executor: record.executor,
      projectId: record.projectId,
      tool: record.tool,
      generatedAt: record.generatedAt,
    })) as typeof record;

    expect(fixRecordHash(reordered)).toBe(record.recordHash);
    expect(verifyFixRecord(reordered).ok).toBe(true);
  });

  it('fails re-derivation after a single byte is changed', () => {
    const record = buildFixRecord(input());
    const tampered = { ...record, before: { ...record.before, scanId: 'scan-A' } };

    const check = verifyFixRecord(tampered);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toContain('recordHash mismatch');
  });

  it('catches a verdict flipped to true even when the hash is recomputed to match', () => {
    // The interesting attack: edit the verdict *and* fix up the hash. The
    // verdict is derived from the evidence, so re-deriving it still catches this.
    const record = buildFixRecord(input({ checks: [{ kind: 'test', command: 'npm test', exitCode: 1, passed: false }] }));
    expect(record.verdict.verified).toBe(false);

    const forged = { ...record, verdict: { verified: true, reasons: [] } };
    const rehashed = { ...forged, recordHash: fixRecordHash(forged) };

    const check = verifyFixRecord(rehashed);
    expect(check.ok).toBe(false);
    expect(check.reasons.join(' ')).toContain('does not follow from the record');
  });

  it('catches an assurance level that the evidence does not support', () => {
    const record = buildFixRecord(input());
    const forged = { ...record, checks: [], assurance: 'scan-and-checks' as const };
    const rehashed = { ...forged, recordHash: fixRecordHash(forged) };

    expect(verifyFixRecord(rehashed).reasons.join(' ')).toContain('assurance says scan-and-checks');
  });

  it('rejects something that is not a fix record at all', () => {
    expect(verifyFixRecord({ hello: 'world' }).ok).toBe(false);
    expect(verifyFixRecord(null).ok).toBe(false);
    expect(verifyFixRecord({ ...buildFixRecord(input()), schema: 'dvalin-fix-record/v9' }).ok).toBe(false);
  });
});

describe('fix verdict', () => {
  it('verifies when the targets are gone and every observed check passed', () => {
    const record = buildFixRecord(input());
    expect(record.verdict.verified).toBe(true);
    expect(record.assurance).toBe('scan-and-checks');
    expect(record.schema).toBe(FIX_RECORD_SCHEMA);
  });

  it('refuses to verify a repair whose project ran no check at all', () => {
    const record = buildFixRecord(input({ checks: [] }));
    expect(record.verdict.verified).toBe(false);
    expect(record.assurance).toBe('scan-only');
    expect(record.verdict.reasons.join(' ')).toContain('unverifiable');
  });

  it('refuses to verify while an original target is still present', () => {
    const record = buildFixRecord(input({
      after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: complete, remainingTargets: [target] },
    }));
    expect(record.verdict.verified).toBe(false);
    expect(record.verdict.reasons.join(' ')).toContain('still present');
  });

  it('records partial coverage as a caveat without silently downgrading a real pass', () => {
    const record = buildFixRecord(input({
      after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: partial, remainingTargets: [] },
    }));

    expect(record.verdict.verified).toBe(true);
    expect(record.verdict.reasons.join(' ')).toContain('coverage is partial');
    expect(verifyFixRecord(record).ok).toBe(true);
  });

  it('does not let the executor change the outcome', () => {
    const asDvalin = buildFixRecord(input({ executor: 'dvalin' }));
    const asHuman = buildFixRecord(input({ executor: 'human' }));

    expect(asDvalin.verdict).toEqual(asHuman.verdict);
    expect(evaluateFixVerdict({
      checks: asDvalin.checks,
      remainingTargets: [],
      beforeCoverage: complete,
      afterCoverage: complete,
    }).verified).toBe(true);
  });
});

describe('rendering', () => {
  it('names the verdict, the assurance, and that the executor was not consulted', () => {
    const text = renderFixRecord(buildFixRecord(input({ audit: { runId: 'run-1', headHash: 'a'.repeat(64) } })));
    expect(text).toContain('VERIFIED');
    expect(text).toContain('scan-and-checks');
    expect(text).toContain('not consulted');
    expect(text).toContain('audit: run run-1');
  });
});
