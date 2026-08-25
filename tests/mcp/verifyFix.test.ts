import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpServer } from '../../src/mcp/server.js';
import { buildFixRecord, fixRecordHash } from '../../src/security/fixRecord.js';
import type { SecurityCoverage, SecurityFindingSnapshot } from '../../src/security/contracts.js';
import type { SecurityWorkflow } from '../../src/security/workflow.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-verify-fix-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

const complete: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

const target: SecurityFindingSnapshot = {
  fingerprint: 'fp-1',
  targetFingerprint: 'tfp-1',
  findingId: 'one',
  source: 'Dvalin Local Scan',
  scanner: 'builtin',
  ruleId: 'dvalin/eval',
  severity: 'error',
  message: 'eval on user input',
  path: 'src/app.ts',
  tags: [],
};

function sampleRecord(passing = true) {
  return buildFixRecord({
    projectId: 'proj-1',
    executor: 'claude-code',
    before: { scanId: 'a', completedAt: '2026-01-01T00:00:00Z', coverage: complete, targets: [target] },
    after: { scanId: 'b', completedAt: '2026-01-01T00:05:00Z', coverage: complete, remainingTargets: [] },
    checks: [{ kind: 'test', command: 'npm test', exitCode: passing ? 0 : 1, passed: passing }],
    generatedAt: '2026-01-01T00:06:00Z',
    version: '0.18.0',
  });
}

function workflowStub(root: string): SecurityWorkflow {
  const scan = {
    id: 'scan-1',
    completedAt: '2026-01-01T00:00:00Z',
    score: 70,
    grade: 'C' as const,
    metrics: { critical: 0, high: 1, medium: 0, low: 0, files: 1, rules: 1 },
    findings: [target],
  };
  return {
    schemaVersion: 2,
    kind: 'dvalin-security-workflow',
    id: 'security-2026-01-01-abcdef12',
    projectId: 'proj-1',
    root,
    state: 'needs_work',
    scanners: ['builtin'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    initialScan: scan,
    latestScan: scan,
    coverage: complete,
    gate: { passed: false, mode: 'all', threshold: 'high', considered: 1, blocking: [target] },
    initialGate: { passed: false, mode: 'all', threshold: 'high', considered: 1, blocking: [target] },
    history: [],
  };
}

describe('dvalin_verify_fix', () => {
  it('re-derives a sound record', async () => {
    const cwd = tempDir();
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_verify_fix',
      arguments: { record: JSON.parse(JSON.stringify(sampleRecord())) },
    }));

    const body = (response as any).result.structuredContent;
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(true);
    expect(body.assurance).toBe('scan-and-checks');
  });

  it('rejects a record edited after it was issued', async () => {
    const cwd = tempDir();
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    const tampered = { ...sampleRecord(), projectId: 'someone-elses-project' };

    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_verify_fix',
      arguments: { record: JSON.parse(JSON.stringify(tampered)) },
    }));

    const body = (response as any).result.structuredContent;
    expect(body.ok).toBe(false);
    expect(body.reasons.join(' ')).toContain('recordHash mismatch');
    // A record that fails to re-derive is a domain answer, not a transport
    // error, so the result carries no isError flag.
    expect((response as any).result.isError).toBeUndefined();
  });

  it('rejects a forged verdict even when the hash was recomputed to match', async () => {
    const cwd = tempDir();
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    const failing = sampleRecord(false);
    const forged = { ...failing, verdict: { verified: true, reasons: [] } };
    const rehashed = { ...forged, recordHash: fixRecordHash(forged) };

    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_verify_fix',
      arguments: { record: JSON.parse(JSON.stringify(rehashed)) },
    }));

    const body = (response as any).result.structuredContent;
    expect(body.ok).toBe(false);
    expect(body.reasons.join(' ')).toContain('does not follow from the record');
  });
});

describe('dvalin_verify_findings', () => {
  it('now runs the project checks and returns a fix record', async () => {
    const cwd = tempDir();
    const workflow = workflowStub(cwd);
    const runVerification = vi.fn(async () => ({
      ...workflow,
      state: 'passed' as const,
      gate: { ...workflow.gate, passed: true, blocking: [] },
      verification: {
        assurance: 'scan-and-checks' as const,
        checks: [{ kind: 'test', command: 'npm test', exitCode: 0, passed: true }],
        verifiedAt: '2026-01-01T00:05:00Z',
        record: sampleRecord(),
      },
    }));

    const server = await createMcpServer(
      { cwd, workspaces: [cwd], maxPermissionMode: 'auto' },
      { loadWorkflow: async () => workflow, runVerification },
    );
    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_verify_findings',
      arguments: { workflow_id: workflow.id, executor: 'codex' },
    }));

    expect(runVerification).toHaveBeenCalledOnce();
    // The executor reaches the record as metadata; it is not a verification input.
    expect(runVerification.mock.calls[0]![0]).toMatchObject({ executor: 'codex' });

    const body = (response as any).result.structuredContent;
    expect(body.assurance).toBe('scan-and-checks');
    expect(body.record.recordHash).toBeTruthy();
    expect(body.coverage.status).toBe('complete');
  });

  it('refuses a workflow rooted outside the permitted workspaces', async () => {
    const cwd = tempDir();
    const outside = tempDir();
    const server = await createMcpServer(
      { cwd, workspaces: [cwd], maxPermissionMode: 'auto' },
      { loadWorkflow: async () => workflowStub(outside), runVerification: vi.fn() },
    );

    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_verify_findings',
      arguments: { workflow_id: 'security-2026-01-01-abcdef12' },
    }));

    expect((response as any).result.isError).toBe(true);
  });
});
