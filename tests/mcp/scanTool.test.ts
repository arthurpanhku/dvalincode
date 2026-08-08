import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpServer } from '../../src/mcp/server.js';
import type { DvalinScanSuiteResult } from '../../src/remediation/scannerSuite.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-mcp-scan-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function call(id: number, args: Record<string, unknown> = {}): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'dvalin_scan', arguments: args },
  });
}

function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'LocalScan:dvalin-eval:app.js:3',
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/eval',
    ruleName: 'Dynamic code execution',
    severity: 'warning' as const,
    securitySeverity: '7.5',
    message: 'Dynamic code execution detected.',
    path: 'app.js',
    startLine: 3,
    endLine: 3,
    helpUri: 'https://cwe.mitre.org/data/definitions/94.html',
    tags: ['security'],
    // Only asserted to be absent from the response, so the value is a
    // placeholder — deliberately not a vulnerable pattern, to keep this file
    // out of .dvalincodeignore.
    snippet: '   3 | <source line>',
    prompt: 'a very long remediation prompt'.repeat(30),
    ...overrides,
  };
}

function scanResult(findings: ReturnType<typeof finding>[]): DvalinScanSuiteResult {
  return {
    id: 'scan-1',
    source: 'Dvalin Security Suite',
    startedAt: '2026-08-08T00:00:00.000Z',
    completedAt: '2026-08-08T00:00:01.000Z',
    score: 88,
    grade: 'B',
    findings,
    totalResults: findings.length,
    skippedResults: 0,
    scanners: [
      { id: 'builtin', name: 'Built-in', category: 'secrets', description: '', available: true, homepage: '', status: 'completed', findings: findings.length, durationMs: 5 },
      { id: 'semgrep', name: 'Semgrep', category: 'sast', description: '', available: false, homepage: '', status: 'missing', findings: 0, durationMs: 0 },
    ],
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: 1, rules: 1 },
  } as DvalinScanSuiteResult;
}

async function serverWith(runScan: ReturnType<typeof vi.fn>, cwd = tempDir()) {
  return { cwd, server: await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' }, { runScan }) };
}

function payload(response: unknown): any {
  return JSON.parse((response as any).result.content[0].text);
}

describe('dvalin_scan', () => {
  it('defaults to the builtin scanner, which needs nothing installed', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([]));
    const { server } = await serverWith(runScan);
    await server.handleLine(call(1));
    expect(runScan.mock.calls[0]![1].scanners).toEqual(['builtin']);
  });

  it('returns the score and findings without the verbose repair prompt', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([finding()]));
    const { server } = await serverWith(runScan);
    const body = payload(await server.handleLine(call(1)));
    expect(body.score).toBe(88);
    expect(body.findings[0].ruleId).toBe('dvalin/eval');
    expect(body.findings[0].startLine).toBe(3);
    expect(body.findings[0].helpUri).toContain('cwe.mitre.org');
    expect(body.findings[0]).not.toHaveProperty('prompt');
    expect(body.findings[0]).not.toHaveProperty('snippet');
  });

  it('includes the repair prompt only when asked', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([finding()]));
    const { server } = await serverWith(runScan);
    const body = payload(await server.handleLine(call(1, { include_remediation_prompts: true })));
    expect(body.findings[0].prompt).toBeTruthy();
  });

  it('caps findings so one scan cannot flood the caller, and says how many there were', async () => {
    const many = Array.from({ length: 120 }, (_, i) => finding({ id: `f${i}`, startLine: i + 1 }));
    const runScan = vi.fn().mockResolvedValue(scanResult(many));
    const { server } = await serverWith(runScan);

    const capped = payload(await server.handleLine(call(1)));
    expect(capped.returnedFindings).toBe(50);
    expect(capped.totalFindings).toBe(120);

    const smaller = payload(await server.handleLine(call(2, { limit: 5 })));
    expect(smaller.returnedFindings).toBe(5);
  });

  it('reports which engines were not installed rather than failing', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([]));
    const { server } = await serverWith(runScan);
    const body = payload(await server.handleLine(call(1)));
    expect(body.scanners.find((s: any) => s.id === 'semgrep').status).toBe('missing');
  });

  it('rejects an unknown scanner instead of silently ignoring it', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([]));
    const { server } = await serverWith(runScan);
    const response: any = await server.handleLine(call(1, { scanners: ['builtin', 'nessus'] }));
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain('nessus');
    expect(runScan).not.toHaveBeenCalled();
  });

  it('refuses a workspace outside the allowed list', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([]));
    const { server } = await serverWith(runScan);
    const outside = tempDir();
    writeFileSync(path.join(outside, 'a.js'), 'const a = 1;\n');
    const response: any = await server.handleLine(call(1, { cwd: outside }));
    expect(response.result.isError).toBe(true);
    expect(runScan).not.toHaveBeenCalled();
  });

  it('passes the timeout through in milliseconds', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([]));
    const { server } = await serverWith(runScan);
    await server.handleLine(call(1, { timeout_seconds: 12 }));
    expect(runScan.mock.calls[0]![1].timeoutMs).toBe(12_000);
  });

  it('scans the server workspace when no cwd is given', async () => {
    const runScan = vi.fn().mockResolvedValue(scanResult([]));
    const { cwd, server } = await serverWith(runScan);
    await server.handleLine(call(1));
    expect(runScan.mock.calls[0]![0]).toContain(path.basename(cwd));
  });
});
