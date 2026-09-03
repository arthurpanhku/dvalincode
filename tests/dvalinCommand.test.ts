import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuditSink } from '../src/audit/log.js';
import {
  buildRunFixRecord,
  dvalinFailureThresholdMet,
  introducedSince,
  parseDvalinScannerIds,
  parsePorcelainZ,
  renderDvalinResult,
} from '../src/commands/dvalin.js';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import {
  buildAutomatedFixPrompt,
  evaluateVerificationGate,
  extractDraftPrUrl,
  VERIFICATION_MARKER,
  verificationEvidenceFromAudit,
} from '../src/remediation/automate.js';
import { renderSecurityGate } from '../src/security/render.js';
import { renderSecuritySuiteToolOutput } from '../src/tools/runSecuritySuite.js';
import { renderSecurityExecution, type ExecutedSecurityScan } from '../src/commands/security.js';

const result: DvalinScanSuiteResult = {
  id: 'scan-test', source: 'Dvalin Security Suite', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
  score: 88, grade: 'B', totalResults: 1, skippedResults: 0,
  metrics: { critical: 0, high: 1, medium: 0, low: 0, files: 1, rules: 1 },
  scanners: [{ id: 'builtin', name: 'Dvalin Built-in', category: 'secrets', description: 'Local rules', available: true, homepage: 'https://example.test', status: 'completed', findings: 1, durationMs: 12 }],
  findings: [{ id: 'one', source: 'Dvalin Local Scan', ruleId: 'dvalin/secret', ruleName: 'Secret', severity: 'error', securitySeverity: '8.0', message: 'Secret found', path: 'src/app.ts', startLine: 4, tags: [], prompt: 'Fix it' }],
};

describe('dvalin command helpers', () => {
  it('parses and validates scanner selection', () => {
    expect(parseDvalinScannerIds('builtin, semgrep,builtin')).toEqual(['builtin', 'semgrep']);
    expect(() => parseDvalinScannerIds('unknown')).toThrow('Unknown scanner');
  });

  it('renders actionable scan output', () => {
    const output = renderDvalinResult(result, '/repo', 10);
    expect(output).toContain('Health 88/100 (B)');
    expect(output).toContain('[HIGH] src/app.ts:4');
    expect(output).toContain('Coverage: complete');
  });

  it('carries partial coverage into agent and TUI tool output', () => {
    const partial = {
      ...result,
      scanners: [
        ...result.scanners,
        { id: 'semgrep' as const, name: 'Semgrep CE', category: 'sast', description: '', available: false, homepage: '', status: 'missing' as const, findings: 0, durationMs: 0 },
      ],
    };
    const output = renderSecuritySuiteToolOutput(partial);
    expect(output).toContain('Coverage: partial');
    expect(output).toContain('deferred: Semgrep CE: missing');
  });

  it('distinguishes an advisory threshold from a passing gate', () => {
    expect(renderSecurityGate({ passed: true, mode: 'all', threshold: 'none', considered: 1, blocking: [] }))
      .toBe('Gate: ADVISORY · all findings · threshold none');
    expect(renderSecurityGate({ passed: true, mode: 'new', threshold: 'high', considered: 0, blocking: [] }))
      .toBe('Gate: PASS · new findings · threshold high');
  });

  it('renders policy-aware coverage once beside the security gate', () => {
    const coverage = {
      status: 'complete' as const,
      scanners: [{ id: 'builtin' as const, status: 'completed' as const }],
      exclusions: ['dvalin/secret in src/app.ts (suppressed)'],
      deferred: [],
      notes: [],
    };
    const execution = {
      schemaVersion: 2,
      scan: result,
      coverage,
      gate: { passed: true, mode: 'all', threshold: 'none', considered: 1, blocking: [] },
      root: '/repo',
      config: {},
      suppressed: 1,
      expiredSuppressions: 0,
    } as ExecutedSecurityScan;
    const output = renderSecurityExecution(execution, 10);
    expect(output.match(/Coverage:/g)).toHaveLength(1);
    expect(output).toContain('excluded: dvalin/secret in src/app.ts (suppressed)');
    expect(output).toContain('Gate: ADVISORY');
  });

  it('supports CI severity thresholds', () => {
    expect(dvalinFailureThresholdMet(result, 'critical')).toBe(false);
    expect(dvalinFailureThresholdMet(result, 'high')).toBe(true);
    expect(dvalinFailureThresholdMet(result, 'none')).toBe(false);
  });

  it('builds a source-validation-first remediation prompt', () => {
    const prompt = buildAutomatedFixPrompt(result.findings, 'Use an isolated worktree.');
    expect(prompt).toContain('Treat scanner output as a hypothesis');
    expect(prompt).toContain('Do not commit, push');
  });

  it('blocks publication unless tests and the independent re-scan pass', () => {
    expect(evaluateVerificationGate({
      originals: result.findings,
      after: { ...result, findings: [], metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 } },
      agentOutput: `Tests passed\n${VERIFICATION_MARKER}`,
      hasChanges: true,
    })).toEqual({ passed: true, reasons: [] });

    const failed = evaluateVerificationGate({
      originals: result.findings,
      after: result,
      agentOutput: 'Tests failed\nDVALIN_VERIFICATION_FAILED',
      hasChanges: true,
    });
    expect(failed.passed).toBe(false);
    expect(failed.reasons).toHaveLength(2);
  });

  it('uses recorded run_check exit codes as deterministic test evidence', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'dvalin-check-evidence-'));
    try {
      const sink = new AuditSink('check-run', directory);
      sink.append({ type: 'tool_call', tool: 'run_check', argsSummary: 'kind=test', status: 'ok', durationMs: 5 });
      sink.append({ type: 'shell_exec', command: 'npm', exitCode: 0, sandbox: 'none' });
      const evidence = verificationEvidenceFromAudit('check-run', directory);
      expect(evidence).toEqual([{ kind: 'kind=test', command: 'npm', exitCode: 0, passed: true }]);
      expect(evaluateVerificationGate({
        originals: result.findings,
        after: { ...result, findings: [], metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 } },
        agentOutput: 'Model text does not decide the gate.',
        hasChanges: true,
        checkEvidence: evidence,
      }).passed).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not classify untouched baseline findings outside the fix cap as new', () => {
    const other = { ...result.findings[0], id: 'two', path: 'src/other.ts' };
    const gate = evaluateVerificationGate({
      originals: result.findings,
      baseline: [...result.findings, other],
      after: { ...result, findings: [other] },
      agentOutput: VERIFICATION_MARKER,
      hasChanges: true,
    });
    expect(gate).toEqual({ passed: true, reasons: [] });
  });

  it('extracts only GitHub pull request URLs from publication output', () => {
    expect(extractDraftPrUrl('Created https://github.com/acme/repo/pull/42')).toBe('https://github.com/acme/repo/pull/42');
    expect(extractDraftPrUrl('No PR was created')).toBeUndefined();
  });
});

describe('parsePorcelainZ', () => {
  it('reads NUL-separated names, so a path with a space survives', () => {
    expect(parsePorcelainZ(' M src/a b.ts\0?? src/new.ts\0')).toEqual(['src/a b.ts', 'src/new.ts']);
  });

  it('takes the destination of a rename and skips its origin field', () => {
    // Rename entries carry two names; splitting on whitespace produced the
    // literal "old -> new" as if it were a path.
    expect(parsePorcelainZ('R  src/new.ts\0src/old.ts\0 M src/other.ts\0'))
      .toEqual(['src/new.ts', 'src/other.ts']);
  });

  it('reports nothing for a clean tree', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe('introduced findings on the --fix path', () => {
  const scan = (findings: DvalinScanSuiteResult['findings']): DvalinScanSuiteResult => ({
    id: 'scan', source: 'Dvalin Security Suite', startedAt: 'a', completedAt: 'b',
    score: 90, grade: 'B', totalResults: findings.length, skippedResults: 0,
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: 1, rules: 1 },
    scanners: [{ id: 'builtin', name: 'Built-in', category: 'secrets', description: '', available: true, homepage: '', status: 'completed', findings: findings.length, durationMs: 1 }],
    findings,
  });

  const evalFinding: DvalinScanSuiteResult['findings'][number] = {
    id: 'one', source: 'Dvalin Local Scan', ruleId: 'dvalin/eval', ruleName: 'Eval',
    severity: 'error', securitySeverity: '8.0', message: 'eval', path: 'src/app.ts', startLine: 4, tags: [], prompt: 'x',
  };
  const sqlFinding: DvalinScanSuiteResult['findings'][number] = {
    ...evalFinding, id: 'two', ruleId: 'dvalin/sql-string-concatenation', securitySeverity: '9.1',
    message: 'sql', path: 'src/db.ts', startLine: 12,
  };

  it('reports what the re-scan has that the baseline did not', () => {
    const introduced = introducedSince([evalFinding], scan([evalFinding, sqlFinding]));

    // The bug this closes: the repair cleared its target and added an
    // injection, and the record used to call that verified.
    expect(introduced.map(finding => finding.ruleId)).toEqual(['dvalin/sql-string-concatenation']);
  });

  it('does not blame the repair for what the baseline already had', () => {
    expect(introducedSince([evalFinding, sqlFinding], scan([evalFinding, sqlFinding]))).toEqual([]);
  });

  it('reports an empty list rather than nothing when the repair added nothing', () => {
    // Distinct from the `null` that means nobody looked -- which is the whole
    // reason the field is three-state.
    expect(introducedSince([evalFinding], scan([evalFinding]))).toEqual([]);
  });

  it('keeps findings below the blocking threshold in the list', () => {
    const note = { ...evalFinding, id: 'three', ruleId: 'dvalin/style', severity: 'note' as const, securitySeverity: '1.0', path: 'src/x.ts' };
    const introduced = introducedSince([], scan([note]));

    // The record keeps the observation; the recorded threshold decides what
    // blocks. Filtering here would throw away evidence a stricter reader wants.
    expect(introduced.map(finding => finding.ruleId)).toEqual(['dvalin/style']);
  });
});

describe('the record a --fix --verify run issues', () => {
  const scan = (id: string, findings: DvalinScanSuiteResult['findings']): DvalinScanSuiteResult => ({
    id, source: 'Dvalin Security Suite', startedAt: 'a', completedAt: 'b',
    score: 90, grade: 'B', totalResults: findings.length, skippedResults: 0,
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: 1, rules: 1 },
    scanners: [{ id: 'builtin', name: 'Built-in', category: 'secrets', description: '', available: true, homepage: '', status: 'completed', findings: findings.length, durationMs: 1 }],
    findings,
  });

  const evalFinding: DvalinScanSuiteResult['findings'][number] = {
    id: 'one', source: 'Dvalin Local Scan', ruleId: 'dvalin/eval', ruleName: 'Eval',
    severity: 'error', securitySeverity: '8.0', message: 'eval', path: 'src/app.ts', startLine: 4, tags: [], prompt: 'x',
  };
  const sqlFinding: DvalinScanSuiteResult['findings'][number] = {
    ...evalFinding, id: 'two', ruleId: 'dvalin/sql-string-concatenation', securitySeverity: '9.1',
    message: 'sql', path: 'src/db.ts', startLine: 12,
  };
  const passing = [{ kind: 'test', command: 'npm test', exitCode: 0, passed: true }];

  const build = (after: DvalinScanSuiteResult) => buildRunFixRecord({
    root: '/tmp/project',
    executor: 'codex',
    before: scan('before', [evalFinding]),
    after,
    targets: [evalFinding],
    baseline: [evalFinding],
    checks: passing,
  });

  it('refuses a repair that cleared its target and introduced an injection', () => {
    const record = build(scan('after', [sqlFinding]));

    // The defect, on the path that had it: the eval target is gone and the
    // project's checks pass, and before this the record said VERIFIED while
    // the command itself rejected the run a moment later.
    expect(record.after.remainingTargets).toHaveLength(0);
    expect(record.verdict.verified).toBe(false);
    expect(record.outcome).toBe('regressed');
  });

  it('verifies a clean repair, and says what it looked for', () => {
    const record = build(scan('after', []));
    expect(record.verdict.verified).toBe(true);
    expect(record.outcome).toBe('verified');
    expect(record.after.introduced).toEqual([]);
  });

  it('carries the rule it was judged under so a third party can re-derive it', () => {
    const record = build(scan('after', []));
    expect(record.schema).toBe('dvalin-fix-record/v2');
    expect(record.gate).toEqual({ threshold: 'high', mode: 'new' });
  });
});
