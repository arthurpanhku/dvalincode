import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuditSink } from '../src/audit/log.js';
import {
  dvalinFailureThresholdMet,
  parseDvalinScannerIds,
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
