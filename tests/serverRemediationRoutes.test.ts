import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';

import { executeSecurityScan, type ExecutedSecurityScan } from '../src/commands/security.js';
import { upsertRemediationCases, type RemediationCase } from '../src/remediation/cases.js';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';
import { buildFixRecord, type FixRecordInput } from '../src/security/fixRecord.js';
import type { SecurityCoverage, SecurityFindingSnapshot } from '../src/security/contracts.js';
import {
  handleSuiteRequest,
  handleVerifyFixRequest,
  type SuiteRouteDeps,
} from '../src/server/routes/remediation.js';
import { issueScannerWorkspaceGrant } from '../src/server/scannerWorkspaceGrants.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-server-remediation-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(body: unknown): Request {
  return { body } as Request;
}

function responseCapture(): {
  res: Response;
  result: { status: number; body?: unknown };
} {
  const result: { status: number; body?: unknown } = { status: 200 };
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(body: unknown) {
      result.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, result };
}

const finding: RemediationFinding = {
  id: 'LocalScan:dvalin-eval:app.js:3',
  source: 'Dvalin Local Scan',
  scanner: 'builtin',
  ruleId: 'dvalin/eval',
  ruleName: 'Dynamic code execution',
  severity: 'warning',
  securitySeverity: '7.5',
  message: 'Dynamic code execution detected.',
  path: 'app.js',
  startLine: 3,
  endLine: 3,
  tags: ['security'],
  prompt: 'Replace dynamic evaluation with an explicit parser.',
};

const scan: DvalinScanSuiteResult = {
  id: 'scan-server-1',
  source: 'Dvalin Security Suite',
  startedAt: '2026-08-26T00:00:00.000Z',
  completedAt: '2026-08-26T00:00:01.000Z',
  score: 88,
  grade: 'B',
  findings: [finding],
  totalResults: 1,
  skippedResults: 0,
  scanners: [
    {
      id: 'builtin',
      name: 'Dvalin Built-in',
      category: 'secrets',
      description: '',
      available: true,
      homepage: '',
      status: 'completed',
      findings: 1,
      durationMs: 5,
    },
    {
      id: 'semgrep',
      name: 'Semgrep CE',
      category: 'sast',
      description: '',
      available: false,
      homepage: '',
      status: 'missing',
      findings: 0,
      durationMs: 0,
    },
  ],
  metrics: { critical: 0, high: 1, medium: 0, low: 0, files: 1, rules: 1 },
  scope: { ref: 'origin/main...HEAD', files: 1 },
};

const partialCoverage: SecurityCoverage = {
  status: 'partial',
  scanners: [
    { id: 'builtin', status: 'completed' },
    { id: 'semgrep', status: 'missing' },
  ],
  exclusions: [],
  deferred: ['Semgrep CE: missing'],
  notes: [],
};

function scanExecution(root: string): ExecutedSecurityScan {
  return {
    schemaVersion: 2,
    scan,
    coverage: partialCoverage,
    gate: { passed: false, mode: 'all', threshold: 'high', considered: 1, blocking: [] },
    root,
    config: {
      version: 1,
      scanners: ['builtin', 'semgrep'],
      gate: { severity: 'high', mode: 'all' },
      baseline: '.dvalin/baseline.json',
      checks: ['test'],
      suppressions: [],
    },
    suppressed: 0,
    expiredSuppressions: 0,
  };
}

function remediationCase(cwd: string): RemediationCase {
  return {
    id: 'rem_case_1',
    findingId: finding.id,
    source: finding.source,
    cwd,
    ruleId: finding.ruleId,
    severity: finding.severity,
    securitySeverity: finding.securitySeverity,
    message: finding.message,
    path: finding.path,
    startLine: finding.startLine,
    tags: finding.tags,
    prompt: finding.prompt,
    status: 'open',
    createdAt: '2026-08-26T00:00:01.000Z',
    updatedAt: '2026-08-26T00:00:01.000Z',
  };
}

function mockedSuiteDeps(root: string): {
  deps: SuiteRouteDeps;
  executeScan: ReturnType<typeof vi.fn>;
  consumeGrant: ReturnType<typeof vi.fn>;
  upsertCases: ReturnType<typeof vi.fn>;
} {
  const executeScan = vi.fn().mockResolvedValue(scanExecution(root));
  const consumeGrant = vi.fn().mockReturnValue(root);
  const upsertCases = vi.fn().mockResolvedValue([remediationCase(root)]);
  return {
    deps: {
      executeScan: executeScan as typeof executeSecurityScan,
      consumeGrant: consumeGrant as SuiteRouteDeps['consumeGrant'],
      upsertCases: upsertCases as typeof upsertRemediationCases,
    },
    executeScan,
    consumeGrant,
    upsertCases,
  };
}

describe('POST /suite contract', () => {
  it('adds the verification envelope while preserving every legacy scan field', async () => {
    const trustedRoot = '/server/authorized/workspace';
    const { deps, executeScan, consumeGrant, upsertCases } = mockedSuiteDeps(trustedRoot);
    const { res, result } = responseCapture();

    await handleSuiteRequest(request({
      grant: 'opaque-grant',
      scanners: ['builtin', 'semgrep'],
      root: '/request-controlled/outside',
    }), res, deps);

    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;

    // These are the fields the old `{ ...result, cases }` response exposed.
    expect(body.id).toBe(scan.id);
    expect(body.source).toBe(scan.source);
    expect(body.startedAt).toBe(scan.startedAt);
    expect(body.completedAt).toBe(scan.completedAt);
    expect(body.score).toBe(scan.score);
    expect(body.grade).toBe(scan.grade);
    expect(body.findings).toBe(scan.findings);
    expect(body.totalResults).toBe(scan.totalResults);
    expect(body.skippedResults).toBe(scan.skippedResults);
    expect(body.scanners).toBe(scan.scanners);
    expect(body.metrics).toBe(scan.metrics);
    expect(body.scope).toBe(scan.scope);
    expect(body.cases).toEqual([remediationCase(trustedRoot)]);

    expect(body.scan).toBe(scan);
    expect(body.schemaVersion).toBe(2);
    expect(body.coverage).toBe(partialCoverage);
    expect(['complete', 'partial', 'unknown']).toContain((body.coverage as SecurityCoverage).status);
    expect((body.coverage as SecurityCoverage).status).toBe('partial');
    expect((body.coverage as SecurityCoverage).deferred).not.toHaveLength(0);
    expect(body.gate).toEqual(scanExecution(trustedRoot).gate);
    expect(body.delta).toBeNull();
    expect(body.workflowId).toBeNull();

    expect(consumeGrant).toHaveBeenCalledWith('opaque-grant');
    expect(executeScan).toHaveBeenCalledWith({
      root: trustedRoot,
      scanners: ['builtin', 'semgrep'],
      saveWorkflow: false,
    });
    expect(upsertCases).toHaveBeenCalledWith({ cwd: trustedRoot, findings: scan.findings });
  });

  it('returns a new-mode missing-baseline UsageError as 400 with its message intact', async () => {
    const root = tempDir();
    writeFileSync(path.join(root, 'dvalin.security.json'), JSON.stringify({
      version: 1,
      scanners: ['builtin'],
      gate: { severity: 'high', mode: 'new' },
      baseline: '.dvalin/missing-baseline.json',
      checks: ['test'],
      suppressions: [],
    }));
    const grant = issueScannerWorkspaceGrant(root);
    const { res, result } = responseCapture();

    await handleSuiteRequest(request({ grant, scanners: ['builtin'] }), res);

    expect(result.status).toBe(400);
    const body = result.body as { error: string };
    expect(body.error).toContain('Cannot read security baseline');
    expect(body.error).toContain('Run `dvalin baseline`');
  });
});

const completeCoverage: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

const target: SecurityFindingSnapshot = {
  fingerprint: 'fp-1',
  targetFingerprint: 'tfp-1',
  findingId: 'finding-1',
  source: 'Dvalin Local Scan',
  scanner: 'builtin',
  ruleId: 'dvalin/eval',
  severity: 'warning',
  message: 'Dynamic code execution detected.',
  path: 'app.js',
  startLine: 3,
  tags: ['security'],
};

function fixRecordInput(): FixRecordInput {
  return {
    projectId: 'project-1',
    executor: 'claude-code',
    before: { scanId: 'before', completedAt: '2026-08-26T00:00:00.000Z', coverage: completeCoverage, targets: [target] },
    after: { scanId: 'after', completedAt: '2026-08-26T00:05:00.000Z', coverage: completeCoverage, remainingTargets: [] },
    checks: [{ kind: 'test', command: 'npm test', exitCode: 0, passed: true }],
    generatedAt: '2026-08-26T00:06:00.000Z',
    version: '0.18.0',
  };
}

describe('POST /verify-fix contract', () => {
  it('re-derives a tampered record offline and reports the hash mismatch', () => {
    const record = buildFixRecord(fixRecordInput());
    const tampered = { ...record, before: { ...record.before, scanId: 'tampered' } };
    const { res, result } = responseCapture();

    handleVerifyFixRequest(request(tampered), res);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, record: tampered });
    expect((result.body as { reasons: string[] }).reasons.join(' ')).toContain('recordHash mismatch');
  });
});
