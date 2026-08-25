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

const passingCheck = { kind: 'test', command: 'npm test', exitCode: 0, passed: true };

async function needsWork() {
  const initial = result();
  const gate = evaluateSecurityGate({ result: initial, threshold: 'high', mode: 'all' });
  return createSecurityWorkflow({ root: home, result: initial, gate });
}

describe.sequential('persistent security workflow', () => {
  it('resumes by id and passes once the re-scan clears the target and a check was observed', async () => {
    const created = await needsWork();
    expect(created.state).toBe('needs_work');
    expect((await loadSecurityWorkflow(created.id)).initialScan.findings).toHaveLength(1);

    const after = result([]);
    const verified = await verifySecurityWorkflow({
      workflow: created,
      result: after,
      gate: evaluateWorkflowVerificationGate(created, after),
      checks: [passingCheck],
    });

    expect(verified.state).toBe('passed');
    expect(verified.verification?.assurance).toBe('scan-and-checks');
    expect(verified.verification?.record?.verdict.verified).toBe(true);
  });

  it('does not pass a repair no check could confirm, however clean the re-scan', async () => {
    // every() over an empty list is vacuously true, which used to pass any
    // project without runnable checks. An unverifiable repair is not a verified one.
    const created = await needsWork();
    const after = result([]);

    const verified = await verifySecurityWorkflow({
      workflow: created,
      result: after,
      gate: evaluateWorkflowVerificationGate(created, after),
    });

    expect(verified.state).toBe('needs_work');
    expect(verified.verification?.assurance).toBe('scan-only');
    expect(verified.verification?.record?.verdict.reasons.join(' ')).toContain('unverifiable');
  });

  it('does not pass a clean re-scan when an observed check failed', async () => {
    const created = await needsWork();
    const after = result([]);

    const verified = await verifySecurityWorkflow({
      workflow: created,
      result: after,
      gate: evaluateWorkflowVerificationGate(created, after),
      checks: [{ kind: 'test', command: 'npm test', exitCode: 1, passed: false }],
    });

    expect(verified.state).toBe('needs_work');
    expect(verified.verification?.record?.verdict.verified).toBe(false);
  });

  it('keeps judging against the original targets across repeated verification rounds', async () => {
    const created = await needsWork();
    const clean = result([]);

    // A first round clears the target and overwrites `gate`.
    const first = await verifySecurityWorkflow({
      workflow: created,
      result: clean,
      gate: evaluateWorkflowVerificationGate(created, clean),
      checks: [passingCheck],
    });
    expect(first.state).toBe('passed');

    // A second round must still measure against what the workflow set out to
    // fix, not against the first round's now-empty result.
    const regressed = result();
    const second = await verifySecurityWorkflow({
      workflow: first,
      result: regressed,
      gate: evaluateWorkflowVerificationGate(first, regressed),
      checks: [passingCheck],
    });

    expect(second.state).toBe('needs_work');
    expect(second.verification?.record?.after.remainingTargets).toHaveLength(1);
  });
});
