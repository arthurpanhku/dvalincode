import { describe, expect, it } from 'vitest';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import { compareWithBaseline, createBaseline, evaluateSecurityGate, findingFingerprint } from '../src/security/contracts.js';

function result(findings: DvalinScanSuiteResult['findings']): DvalinScanSuiteResult {
  return {
    id: 'scan-test', source: 'Dvalin Security Suite', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
    score: 88, grade: 'B', totalResults: findings.length, skippedResults: 0,
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: findings.length, rules: findings.length },
    scanners: [{ id: 'builtin', name: 'Built-in', category: 'secrets', description: '', available: true, homepage: '', status: 'completed', findings: findings.length, durationMs: 1 }],
    findings,
  };
}

const finding: DvalinScanSuiteResult['findings'][number] = {
  id: 'one', source: 'Dvalin Local Scan', ruleId: 'dvalin/secret', ruleName: 'Secret', severity: 'error',
  securitySeverity: '8.0', message: 'Secret found', path: 'src/app.ts', startLine: 4, tags: [], prompt: 'Fix it',
};

describe('versioned security contracts', () => {
  it('creates stable fingerprints and new/existing/resolved deltas', () => {
    expect(findingFingerprint(finding)).toBe(findingFingerprint({ ...finding, path: './src/app.ts' }));
    const baseline = createBaseline(result([finding]));
    const added = { ...finding, id: 'two', ruleId: 'dvalin/eval', message: 'Eval found', startLine: 10 };
    const delta = compareWithBaseline(result([finding, added]), baseline);
    expect(delta.existing).toHaveLength(1);
    expect(delta.new).toHaveLength(1);
    expect(delta.resolved).toHaveLength(0);
  });

  it('blocks only new findings when configured as a new-only gate', () => {
    const baseline = createBaseline(result([finding]));
    const added = { ...finding, id: 'two', path: 'src/new.ts' };
    const current = result([finding, added]);
    const delta = compareWithBaseline(current, baseline);
    const gate = evaluateSecurityGate({ result: current, threshold: 'high', mode: 'new', delta });
    expect(gate.passed).toBe(false);
    expect(gate.considered).toBe(1);
    expect(gate.blocking[0]?.path).toBe('src/new.ts');
  });
});
