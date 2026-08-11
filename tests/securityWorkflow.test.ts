import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import { evaluateSecurityGate } from '../src/security/contracts.js';
import { createSecurityWorkflow, evaluateWorkflowVerificationGate, loadSecurityWorkflow, verifySecurityWorkflow } from '../src/security/workflow.js';

let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'dvalin-security-workflow-'));
  originalHome = process.env.DVALINCODE_HOME;
  process.env.DVALINCODE_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.DVALINCODE_HOME;
  else process.env.DVALINCODE_HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

const finding: DvalinScanSuiteResult['findings'][number] = {
  id: 'one', source: 'Dvalin Local Scan', ruleId: 'dvalin/eval', ruleName: 'Eval', severity: 'error', securitySeverity: '8.0',
  message: 'Eval found', path: 'src/app.ts', startLine: 4, tags: [], prompt: 'Fix it',
};

function result(findings = [finding]): DvalinScanSuiteResult {
  return {
    id: `scan-${findings.length}`, source: 'Dvalin Security Suite', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z',
    score: findings.length ? 88 : 100, grade: findings.length ? 'B' : 'A', totalResults: findings.length, skippedResults: 0,
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: findings.length, rules: findings.length },
    scanners: [{ id: 'builtin', name: 'Built-in', category: 'secrets', description: '', available: true, homepage: '', status: 'completed', findings: findings.length, durationMs: 1 }],
    findings,
  };
}

describe.sequential('persistent security workflow', () => {
  it('resumes by id and passes only after a deterministic re-scan clears the target', async () => {
    const initial = result();
    const gate = evaluateSecurityGate({ result: initial, threshold: 'high', mode: 'all' });
    const created = await createSecurityWorkflow({ root: home, result: initial, gate });
    expect(created.state).toBe('needs_work');
    expect((await loadSecurityWorkflow(created.id)).initialScan.findings).toHaveLength(1);

    const after = result([]);
    const verificationGate = evaluateWorkflowVerificationGate(created, after);
    const verified = await verifySecurityWorkflow({ workflow: created, result: after, gate: verificationGate });
    expect(verified.state).toBe('passed');
    expect(verified.verification?.assurance).toBe('scan-only');
  });
});
