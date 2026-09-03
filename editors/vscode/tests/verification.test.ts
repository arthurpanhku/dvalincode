import { describe, expect, it } from 'vitest';
import {
  classifyVerificationExit,
  renderFixRecordVerification,
  verifyFixArgs,
  type FixRecordVerification,
} from '../src/verification.js';

function verification(overrides: Partial<FixRecordVerification> = {}): FixRecordVerification {
  return {
    schemaVersion: 2,
    path: '/repo/fix-record.json',
    ok: true,
    reasons: [],
    record: {
      recordHash: 'abcdef1234567890',
      assurance: 'scan-and-checks',
      executor: 'claude-code',
      verdict: { verified: true, reasons: [] },
      before: { coverage: { status: 'complete' } },
      after: { coverage: { status: 'complete' } },
    },
    ...overrides,
  };
}

describe('offline fix-record verification', () => {
  it('uses the public CLI contract', () => {
    expect(verifyFixArgs('/repo/fix record.json')).toEqual([
      'security', 'verify-fix', '/repo/fix record.json', '--json',
    ]);
  });

  it('accepts a JSON gate answer even when a tampered record exits non-zero', () => {
    const answer = verification({ ok: false, reasons: ['recordHash mismatch'] });
    const outcome = classifyVerificationExit(3, JSON.stringify(answer), '');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.verification.reasons).toContain('recordHash mismatch');
  });

  it('separates process failure from a negative verification verdict', () => {
    const outcome = classifyVerificationExit(2, '', 'Cannot read fix record');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('Cannot read');
  });

  it('labels the executor as recorded rather than trusted', () => {
    expect(renderFixRecordVerification(verification())).toContain('recorded, not consulted');
  });
});
