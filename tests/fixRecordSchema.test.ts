import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { buildFixRecord, type FixRecordGate, type FixRecordInput } from '../src/security/fixRecord.js';
import type { SecurityCoverage, SecurityFindingSnapshot } from '../src/security/contracts.js';

// ajv ships CJS; under ESM the callable lands on `.default` (see tests/mcpServerManifest.test.ts).
// The schema declares $schema: draft/2020-12, which ajv's default export does not
// understand — that dialect lives at the dedicated ajv/dist/2020 entry point.
const AjvCtor = ((Ajv2020 as any).default ?? Ajv2020) as typeof Ajv2020;
const applyFormats = ((addFormats as any).default ?? addFormats) as typeof addFormats;

/**
 * The schema published for FVP-1 implementers (FV-11a) is informative, not
 * normative — but an informative schema that has drifted from what
 * `buildFixRecord` actually emits is worse than no schema, because it teaches
 * a re-implementer the wrong shape. These tests compile it once and throw
 * real records at it, so a change to either side that breaks the other fails
 * here rather than in someone else's independent implementation.
 */
const schemaPath = path.join(__dirname, '..', 'docs', 'spec', 'fix-record.schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const ajv = new AjvCtor({ allErrors: true, strict: false });
applyFormats(ajv);
const validate = ajv.compile(schema);

function expectValid(record: unknown): void {
  const ok = validate(record);
  expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

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

function finding(overrides: Partial<SecurityFindingSnapshot> = {}): SecurityFindingSnapshot {
  return {
    fingerprint: 'fp-1',
    targetFingerprint: 'tfp-1',
    findingId: 'one',
    source: 'Dvalin Local Scan',
    scanner: 'builtin',
    ruleId: 'dvalin/eval',
    severity: 'error',
    securitySeverity: '9.1',
    message: 'eval on user input',
    path: 'src/app.ts',
    startLine: 4,
    tags: [],
    ...overrides,
  };
}

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

describe('the published fix-record schema matches the reference implementation', () => {
  it('accepts a v1 record', () => {
    expectValid(buildFixRecord(input()));
  });

  it('accepts a v1 record with partial coverage and a failed check', () => {
    expectValid(buildFixRecord(input({
      before: { ...input().before, coverage: partial },
      checks: [{ kind: 'test', command: 'npm test', exitCode: 1, passed: false }],
    })));
  });

  it('accepts a verified v2 record', () => {
    expectValid(buildFixRecord(input({ regression: { gate, introduced: [] } })));
  });

  it('accepts a regressed v2 record (introduced findings present)', () => {
    const critical = finding({ ruleId: 'dvalin/sql-injection', securitySeverity: '9.5', fingerprint: 'fp-new' });
    expectValid(buildFixRecord(input({ regression: { gate, introduced: [critical] } })));
  });

  it('accepts an unverifiable v2 record (introduced: null)', () => {
    expectValid(buildFixRecord(input({ regression: { gate, introduced: null } })));
  });

  it('accepts a v2 record whose target-remains outcome carries no gate-blocking findings', () => {
    expectValid(buildFixRecord(input({
      regression: { gate, introduced: [] },
      after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: complete, remainingTargets: [finding()] },
    })));
  });

  it('rejects a record with no schema field', () => {
    const record = buildFixRecord(input()) as Record<string, unknown>;
    const { schema: _dropped, ...withoutSchema } = record;
    expect(validate(withoutSchema)).toBe(false);
  });

  it('rejects a v2 record missing `gate`', () => {
    const record = buildFixRecord(input({ regression: { gate, introduced: [] } })) as Record<string, unknown>;
    const { gate: _dropped, ...withoutGate } = record;
    expect(validate(withoutGate)).toBe(false);
  });

  it('rejects a v2 record whose `after.introduced` was stripped', () => {
    const record = buildFixRecord(input({ regression: { gate, introduced: [] } })) as any;
    const { introduced: _dropped, ...restAfter } = record.after;
    expect(validate({ ...record, after: restAfter })).toBe(false);
  });

  it('rejects a malformed recordHash', () => {
    const record = buildFixRecord(input()) as Record<string, unknown>;
    expect(validate({ ...record, recordHash: 'not-a-hex-digest' })).toBe(false);
  });
});
