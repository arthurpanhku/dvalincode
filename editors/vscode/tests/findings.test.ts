import { describe, expect, it } from 'vitest';
import {
  bandOf,
  coverageLabel,
  groupByPath,
  missingScanners,
  rangeOf,
  Severity,
  severityOf,
  summarize,
  toEditorFinding,
  verificationReport,
  type DvalinFinding,
  type DvalinScanResult,
} from '../src/findings.js';

function finding(overrides: Partial<DvalinFinding> = {}): DvalinFinding {
  return {
    id: 'LocalScan:dvalin-eval:app.js:3',
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/eval',
    ruleName: 'Dynamic code execution',
    severity: 'warning',
    securitySeverity: '7.5',
    message: 'Dynamic code execution detected.',
    path: 'app.js',
    startLine: 3,
    endLine: 3,
    helpUri: 'https://cwe.mitre.org/data/definitions/94.html',
    tags: ['security'],
    ...overrides,
  };
}

function result(findings: DvalinFinding[], overrides: Partial<DvalinScanResult> = {}): DvalinScanResult {
  return {
    score: 88,
    grade: 'B',
    findings,
    scanners: [{ id: 'builtin', name: 'Dvalin Built-in', status: 'completed' }],
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: 1, rules: 1 },
    ...overrides,
  };
}

describe('bandOf — mirrors the CLI so squiggles agree with --fail-on', () => {
  it('bands by securitySeverity first', () => {
    expect(bandOf(finding({ securitySeverity: '9.1' }))).toBe('critical');
    expect(bandOf(finding({ securitySeverity: '7.0' }))).toBe('high');
    expect(bandOf(finding({ securitySeverity: '4.0', severity: 'note' }))).toBe('medium');
  });

  it('treats an error-level finding as high even without a score', () => {
    expect(bandOf(finding({ severity: 'error', securitySeverity: undefined }))).toBe('high');
  });

  it('falls back to low when nothing indicates otherwise', () => {
    expect(bandOf(finding({ severity: 'none', securitySeverity: undefined }))).toBe('low');
  });

  it('does not crash on an unparseable score', () => {
    expect(bandOf(finding({ securitySeverity: 'not-a-number', severity: 'note' }))).toBe('low');
  });
});

describe('severityOf', () => {
  it('surfaces critical and high as errors, medium as a warning', () => {
    expect(severityOf('critical')).toBe(Severity.Error);
    expect(severityOf('high')).toBe(Severity.Error);
    expect(severityOf('medium')).toBe(Severity.Warning);
    expect(severityOf('low')).toBe(Severity.Information);
  });
});

describe('rangeOf — 1-based CLI lines to 0-based editor lines', () => {
  it('converts a single line', () => {
    expect(rangeOf(finding({ startLine: 3, endLine: 3 })).startLine).toBe(2);
  });

  it('anchors a finding with no line to the first line', () => {
    const r = rangeOf(finding({ startLine: undefined, endLine: undefined }));
    expect(r.startLine).toBe(0);
    expect(r.endLine).toBe(0);
  });

  it('never produces a negative line from a zero-line finding', () => {
    expect(rangeOf(finding({ startLine: 0, endLine: 0 })).startLine).toBe(0);
  });

  it('never inverts when a scanner reports the end before the start', () => {
    const r = rangeOf(finding({ startLine: 12, endLine: 4 }));
    expect(r.endLine).toBeGreaterThanOrEqual(r.startLine);
  });
});

describe('toEditorFinding', () => {
  it('normalizes Windows separators so the path joins correctly', () => {
    expect(toEditorFinding(finding({ path: 'src\\app.js' })).path).toBe('src/app.js');
  });

  it('appends the rule name to the message when there is one', () => {
    expect(toEditorFinding(finding()).message).toContain('Dynamic code execution');
  });

  it('leaves the message alone when the rule has no name', () => {
    const f = toEditorFinding(finding({ ruleName: undefined }));
    expect(f.message).toBe('Dynamic code execution detected.');
  });
});

describe('groupByPath', () => {
  it('collects every finding for a file under one key', () => {
    const grouped = groupByPath(result([finding(), finding({ id: 'b', startLine: 9 }), finding({ id: 'c', path: 'other.js' })]));
    expect(grouped.get('app.js')).toHaveLength(2);
    expect(grouped.get('other.js')).toHaveLength(1);
  });

  it('returns an empty map for a clean scan', () => {
    expect(groupByPath(result([])).size).toBe(0);
  });
});

describe('missingScanners', () => {
  it('reports only the ones that were not installed', () => {
    const r = result([], {
      scanners: [
        { id: 'builtin', name: 'Built-in', status: 'completed' },
        { id: 'semgrep', name: 'Semgrep', status: 'missing' },
        { id: 'trivy', name: 'Trivy', status: 'error', error: 'boom' },
      ],
    });
    expect(missingScanners(r)).toEqual(['semgrep']);
  });
});

describe('summarize', () => {
  it('does not turn a legacy zero-finding result into a complete assurance claim', () => {
    expect(summarize(result([]))).toContain('no findings in covered scope');
    expect(summarize(result([]))).toContain('coverage unknown');
  });

  it('uses the clean wording only when coverage is complete', () => {
    const complete = result([], {
      coverage: { status: 'complete', scanners: [{ id: 'builtin', status: 'completed' }], exclusions: [], deferred: [], notes: [] },
    });
    expect(summarize(complete)).toContain('no actionable findings');
    expect(summarize(complete)).toContain('coverage complete');
  });

  it('leads with the critical count when there is one', () => {
    const r = result([finding()], { metrics: { critical: 2, high: 1, medium: 0, low: 0, files: 1, rules: 1 } });
    expect(summarize(r)).toContain('2 critical');
  });

  it('uses the singular for one finding', () => {
    expect(summarize(result([finding()]))).toContain('1 finding (');
  });
});

describe('verification evidence', () => {
  it('reports engine counts without hiding deferred coverage', () => {
    const partial = result([], {
      coverage: {
        status: 'partial',
        scanners: [
          { id: 'builtin', status: 'completed' },
          { id: 'semgrep', status: 'missing' },
        ],
        exclusions: ['tests/fixture/**'],
        deferred: ['semgrep is not installed'],
        notes: [],
      },
      gate: { passed: true, mode: 'all', threshold: 'none', considered: 0 },
      workflowId: 'security-123',
      schemaVersion: 2,
    });
    expect(coverageLabel(partial)).toBe('coverage partial (1/2 engines)');
    const report = verificationReport(partial);
    expect(report).toContain('Deferred: semgrep is not installed');
    expect(report).toContain('Excluded: tests/fixture/**');
    expect(report).toContain('Gate: passed');
    expect(report).toContain('Workflow: security-123');
  });
});
