import { describe, expect, it } from 'vitest';
import type { DvalinScanSuiteResult, DvalinScannerRun } from '../src/remediation/scannerSuite.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';
import {
  compareWithBaseline,
  createBaseline,
  deriveCoverage,
  evaluateSecurityGate,
  isSecurityBaseline,
  scannerIdForSource,
  unknownCoverage,
} from '../src/security/contracts.js';

function run(id: DvalinScannerRun['id'], status: DvalinScannerRun['status'], findings = 0): DvalinScannerRun {
  return {
    id,
    name: id,
    category: 'sast',
    description: '',
    available: status !== 'missing',
    homepage: '',
    status,
    findings,
    durationMs: 1,
  };
}

function result(
  findings: RemediationFinding[],
  scanners: DvalinScannerRun[] = [run('builtin', 'completed', findings.length)],
  extra: Partial<DvalinScanSuiteResult> = {},
): DvalinScanSuiteResult {
  return {
    id: 'scan-test',
    source: 'Dvalin Security Suite',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    score: 90,
    grade: 'A',
    totalResults: findings.length,
    skippedResults: 0,
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: findings.length, rules: findings.length },
    scanners,
    findings,
    ...extra,
  };
}

const builtinFinding: RemediationFinding = {
  id: 'one',
  source: 'Dvalin Local Scan',
  scanner: 'builtin',
  ruleId: 'dvalin/eval',
  severity: 'error',
  securitySeverity: '8.0',
  message: 'eval on user input',
  path: 'src/app.ts',
  startLine: 4,
  tags: [],
  prompt: 'Fix it',
};

const semgrepFinding: RemediationFinding = {
  ...builtinFinding,
  id: 'two',
  source: 'Semgrep',
  scanner: 'semgrep',
  ruleId: 'javascript.lang.security.audit.sqli',
  message: 'sql concatenation',
  path: 'src/db.ts',
  startLine: 12,
};

describe('deriveCoverage', () => {
  it('is complete only when every selected engine finished and nothing was dropped', () => {
    const coverage = deriveCoverage(result([builtinFinding]));
    expect(coverage.status).toBe('complete');
    expect(coverage.deferred).toEqual([]);
  });

  it('is partial when an engine did not run', () => {
    const coverage = deriveCoverage(result([builtinFinding], [run('builtin', 'completed', 1), run('semgrep', 'missing')]));
    expect(coverage.status).toBe('partial');
    expect(coverage.deferred.join(' ')).toContain('missing');
  });

  it('is partial when scanner results were dropped for lacking a safe location', () => {
    const coverage = deriveCoverage(result([builtinFinding], undefined, { skippedResults: 3 }));
    expect(coverage.status).toBe('partial');
    expect(coverage.deferred.join(' ')).toContain('3 scanner result(s) dropped');
  });

  it('never lets a diff-scoped run imply it covered the repository', () => {
    const coverage = deriveCoverage(result([builtinFinding], undefined, { scope: { ref: 'origin/main...HEAD', files: 2 } }));
    expect(coverage.status).toBe('partial');
    expect(coverage.deferred.join(' ')).toContain('origin/main...HEAD');
  });

  it('records suppressed findings as exclusions rather than silence', () => {
    const coverage = deriveCoverage(result([]), { suppressed: [{ finding: builtinFinding }] });
    expect(coverage.exclusions).toHaveLength(1);
    expect(coverage.exclusions[0]).toContain('dvalin/eval');
  });

  it('reports unknown when no engine outcome was recorded at all', () => {
    expect(deriveCoverage(result([], [])).status).toBe('unknown');
    expect(unknownCoverage('legacy record').status).toBe('unknown');
  });
});

describe('compareWithBaseline lifecycle', () => {
  it('does NOT call a finding resolved when the engine that finds it never ran', () => {
    // The bug this guards: Semgrep is not installed, so its baseline finding is
    // absent from the scan. Absent because unlooked-for is not absent because fixed.
    const baseline = createBaseline(result([builtinFinding, semgrepFinding], [
      run('builtin', 'completed', 1),
      run('semgrep', 'completed', 1),
    ]));
    const delta = compareWithBaseline(
      result([builtinFinding], [run('builtin', 'completed', 1), run('semgrep', 'missing')]),
      baseline,
    );

    expect(delta.resolved).toEqual([]);
    expect(delta.unknown).toHaveLength(1);
    expect(delta.unknown[0]!.ruleId).toBe(semgrepFinding.ruleId);
  });

  it('still resolves a finding when the engine that finds it did complete', () => {
    const baseline = createBaseline(result([builtinFinding, semgrepFinding], [
      run('builtin', 'completed', 1),
      run('semgrep', 'completed', 1),
    ]));
    const delta = compareWithBaseline(
      result([builtinFinding], [run('builtin', 'completed', 1), run('semgrep', 'completed')]),
      baseline,
    );

    expect(delta.unknown).toEqual([]);
    expect(delta.resolved).toHaveLength(1);
    expect(delta.resolved[0]!.ruleId).toBe(semgrepFinding.ruleId);
  });

  it('treats a baseline engine that was not even attempted as a coverage hole', () => {
    const baseline = createBaseline(result([builtinFinding, semgrepFinding], [
      run('builtin', 'completed', 1),
      run('semgrep', 'completed', 1),
    ]));
    // This run selected builtin only, so it never had a chance to see the rest.
    const delta = compareWithBaseline(result([builtinFinding], [run('builtin', 'completed', 1)]), baseline);

    expect(delta.resolved).toEqual([]);
    expect(delta.unknown).toHaveLength(1);
  });

  it('separates a returning target from a genuinely new one', () => {
    const baseline = createBaseline(result([builtinFinding]));
    // Same rule, same file, different line and wording: the target came back.
    const moved = { ...builtinFinding, id: 'moved', startLine: 40, message: 'eval on request body' };
    const elsewhere = { ...builtinFinding, id: 'other', path: 'src/other.ts', ruleId: 'dvalin/shell-command-injection' };
    const delta = compareWithBaseline(result([moved, elsewhere]), baseline);

    expect(delta.reopened.map(finding => finding.findingId)).toEqual(['moved']);
    expect(delta.new.map(finding => finding.findingId)).toEqual(['other']);
  });

  it('reports a suppressed finding as dismissed, not as resolved', () => {
    const baseline = createBaseline(result([builtinFinding]));
    const delta = compareWithBaseline(result([]), baseline, { suppressed: [{ finding: builtinFinding }] });

    expect(delta.resolved).toEqual([]);
    expect(delta.dismissed).toHaveLength(1);
  });
});

describe('schema compatibility', () => {
  it('still reads a v1 baseline, because users commit that file to their repository', () => {
    const current = createBaseline(result([builtinFinding]));
    const legacy = { ...current, schemaVersion: 1, coverage: undefined };
    delete (legacy as Record<string, unknown>).coverage;

    expect(isSecurityBaseline(legacy)).toBe(true);
    expect(isSecurityBaseline({ ...current, schemaVersion: 99 })).toBe(false);
  });

  it('writes the current version with coverage attached', () => {
    const baseline = createBaseline(result([builtinFinding]));
    expect(baseline.schemaVersion).toBe(2);
    expect(baseline.coverage?.status).toBe('complete');
  });

  it('attributes an untagged legacy finding by engine name', () => {
    expect(scannerIdForSource('Dvalin Local Scan')).toBe('builtin');
    expect(scannerIdForSource('Semgrep')).toBe('semgrep');
    expect(scannerIdForSource('Trivy')).toBe('trivy');
    expect(scannerIdForSource('osv-scanner')).toBe('osv-scanner');
    expect(scannerIdForSource('SomeVendorSAST')).toBeUndefined();
  });

  it('will not claim to have covered an unattributable finding while an engine is missing', () => {
    const foreign: RemediationFinding = { ...builtinFinding, id: 'x', source: 'SomeVendorSAST', scanner: undefined };
    const baseline = createBaseline(result([foreign], [run('builtin', 'completed'), run('semgrep', 'completed')]));
    const delta = compareWithBaseline(result([], [run('builtin', 'completed'), run('semgrep', 'missing')]), baseline);

    expect(delta.resolved).toEqual([]);
    expect(delta.unknown).toHaveLength(1);
  });
});

describe('the new-findings gate', () => {
  it('blocks a reopened target, which must not escape by having a precedent', () => {
    // Regression guard: routing same-rule/same-file findings into `reopened`
    // once hid a fresh critical behind any baselined finding of that rule.
    const baseline = createBaseline(result([builtinFinding]));
    const returned = { ...builtinFinding, id: 'back', startLine: 99, message: 'eval on request body' };
    const scan = result([returned]);
    const delta = compareWithBaseline(scan, baseline);

    expect(delta.reopened).toHaveLength(1);
    expect(delta.new).toEqual([]);

    const gate = evaluateSecurityGate({ result: scan, threshold: 'high', mode: 'new', delta });
    expect(gate.passed).toBe(false);
    expect(gate.blocking).toHaveLength(1);
  });

  it('still lets an unchanged baseline finding through the new-findings gate', () => {
    const baseline = createBaseline(result([builtinFinding]));
    const scan = result([builtinFinding]);
    const delta = compareWithBaseline(scan, baseline);

    expect(evaluateSecurityGate({ result: scan, threshold: 'high', mode: 'new', delta }).passed).toBe(true);
  });
});
