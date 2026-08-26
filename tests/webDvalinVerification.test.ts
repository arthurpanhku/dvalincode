import { describe, expect, it } from 'vitest';

import { dvalinEmptyFindingCopy, dvalinVerificationSummary } from '../web/src/lib/dvalinVerification.ts';
import type { DvalinScanResult, DvalinSecurityCoverage, DvalinSecurityGate } from '../web/src/types.ts';

function coverage(status: DvalinSecurityCoverage['status']): DvalinSecurityCoverage {
  return {
    status,
    scanners: [{ id: 'builtin', status: 'completed' }],
    exclusions: [],
    deferred: status === 'partial' ? ['Semgrep CE: missing'] : [],
    notes: [],
  };
}

function scanResult(status: DvalinSecurityCoverage['status'], threshold: DvalinSecurityGate['threshold']): DvalinScanResult {
  return {
    id: 'scan-web-1',
    source: 'Dvalin Security Suite',
    startedAt: '2026-08-26T00:00:00.000Z',
    completedAt: '2026-08-26T00:00:01.000Z',
    score: 100,
    grade: 'A',
    findings: [],
    totalResults: 0,
    skippedResults: 0,
    scanners: [],
    metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 },
    cases: [],
    coverage: coverage(status),
    gate: { passed: true, mode: 'all', threshold, considered: 0, blocking: [] },
  };
}

describe('Dvalin verification copy', () => {
  it('does not present a zero-finding partial scan as secure', () => {
    expect(dvalinEmptyFindingCopy({ coverage: coverage('partial') })).toEqual({
      title: 'No findings in covered scope',
      detail: 'Partial coverage is not full assurance. Review the deferred and excluded work below.',
    });
  });

  it('uses the clean outcome only when selected-engine coverage is complete', () => {
    expect(dvalinEmptyFindingCopy({ coverage: coverage('complete') }).title).toBe('No actionable findings');
  });

  it('treats a legacy response with no coverage as unknown', () => {
    expect(dvalinEmptyFindingCopy({ coverage: undefined }).title).toBe('No findings in covered scope');
  });

  it('requires model review and complete deterministic evidence before calling evidence ready', () => {
    const result = scanResult('complete', 'high');
    expect(dvalinVerificationSummary({ result, modelReviewComplete: false, running: false, gitBranch: 'main' }).status).toBe('needs-attention');
    expect(dvalinVerificationSummary({ result, modelReviewComplete: true, running: false, gitBranch: 'main' }).status).toBe('evidence-ready');
  });

  it('disables draft PR without a branch and explains advisory gates and missing records', () => {
    const result = scanResult('complete', 'none');
    const summary = dvalinVerificationSummary({ result, modelReviewComplete: true, running: false, gitBranch: null });
    expect(summary.draftPrReady).toBe(false);
    expect(summary.notices).toContain('The security gate is advisory because its threshold is none.');
    expect(summary.notices).toContain('No offline Verified Fix Record is attached to this web verification.');
    expect(summary.notices).toContain('Draft PR requires an active Git branch.');
  });

  it('never treats partial zero-finding coverage as passing scan evidence', () => {
    const result = scanResult('partial', 'high');
    expect(dvalinVerificationSummary({ result, modelReviewComplete: true, running: false, gitBranch: 'main' }).scanPassed).toBe(false);
  });
});
