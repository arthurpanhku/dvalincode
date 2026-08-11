import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMcpServer, negotiateProtocolVersion } from '../../src/mcp/server.js';
import type { HarnessRunExecution } from '../../src/harness/run.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DVALINCODE_POLICY_FILE;
  delete process.env.DVALINCODE_SESSIONS_DIR;
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-mcp-server-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function request(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
}

function toolPayload(response: Awaited<ReturnType<Awaited<ReturnType<typeof createMcpServer>>['handleLine']>>): any {
  return (response as any).result;
}

describe('task-level stdio MCP server', () => {
  it('implements initialize and lists exactly the task-level tools', async () => {
    const cwd = tempDir();
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    const initialized = await server.handleLine(request(1, 'initialize', { protocolVersion: '2024-11-05' }));
    expect((initialized as any).result).toMatchObject({ capabilities: { tools: {} }, serverInfo: { name: 'dvalincode' } });

    const listed = await server.handleLine(request(2, 'tools/list'));
    const tools = (listed as any).result.tools;
    // The security workflow leads; general coding remains available as an
    // implementation helper rather than the product's trust boundary.
    expect(tools.map((tool: any) => tool.name)).toEqual([
      'dvalin_scan', 'dvalin_run_task', 'dvalin_get_session', 'dvalin_get_evidence',
      'dvalin_get_finding', 'dvalin_verify_findings', 'dvalin_list_scanners',
    ]);
    const readOnly = Object.fromEntries(
      tools.map((tool: any) => [tool.name, tool.annotations.readOnlyHint]),
    );
    expect(readOnly).toEqual({
      dvalin_scan: false,
      dvalin_run_task: false,
      dvalin_get_session: true,
      dvalin_get_evidence: true,
      dvalin_get_finding: true,
      dvalin_verify_findings: false,
      dvalin_list_scanners: true,
    });
    expect(tools.filter((tool: any) => tool.name !== 'dvalin_get_evidence').every((tool: any) => tool.outputSchema?.type === 'object')).toBe(true);
  });

  it('returns JSON-RPC parse and method-not-found errors', async () => {
    const cwd = tempDir();
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    expect((await server.handleLine('{')) as any).toMatchObject({ id: null, error: { code: -32700 } });
    expect((await server.handleLine(request(1, 'resources/list'))) as any).toMatchObject({ id: 1, error: { code: -32601 } });
  });

  it('rejects bypass above the default auto ceiling as a tool-level policy error', async () => {
    const cwd = tempDir();
    process.env.DVALINCODE_POLICY_FILE = path.join(cwd, 'absent-policy.json');
    process.env.DVALINCODE_SESSIONS_DIR = path.join(cwd, 'sessions');
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_run_task',
      arguments: { prompt: 'change a file', permission_mode: 'bypass' },
    }));
    const payload = toolPayload(response);
    expect(payload.isError).toBe(true);
    const result = JSON.parse(payload.content[0].text);
    expect(result).toMatchObject({ ok: false, stopReason: 'error' });
    expect(result.error).toMatch(/ceiling "auto"/);
  });

  it('rejects cwd outside the launch allowlist before executing a task', async () => {
    const allowed = tempDir();
    const outside = tempDir();
    const executeRun = vi.fn();
    const server = await createMcpServer(
      { cwd: allowed, workspaces: [allowed], maxPermissionMode: 'auto' },
      { executeRun },
    );
    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_run_task', arguments: { prompt: 'work', cwd: outside },
    }));
    expect(toolPayload(response)).toMatchObject({ isError: true });
    expect(toolPayload(response).content[0].text).toMatch(/outside.*allowlist/);
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('delegates dvalin_run_task through the shared runner with mcp audit provenance', async () => {
    const cwd = tempDir();
    const execution: HarnessRunExecution = {
      exitCode: 0,
      result: {
        ok: true,
        sessionId: 'dc_1',
        runId: 'run_1',
        auditHead: 'head',
        policyHash: 'policy',
        provider: 'mock',
        model: 'm',
        iterationsUsed: 1,
        toolCalls: 0,
        usage: { inputTokens: 1, outputTokens: 1 },
        wallSeconds: 0.1,
        output: 'done',
        stopReason: 'done',
      },
    };
    const executeRun = vi.fn(async () => execution);
    const server = await createMcpServer(
      { cwd, workspaces: [cwd], maxPermissionMode: 'auto' },
      { executeRun },
    );
    const response = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_run_task', arguments: { prompt: 'work' },
    }));
    expect(JSON.parse(toolPayload(response).content[0].text)).toMatchObject({ ok: true, runId: 'run_1' });
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      cwd: realpathSync(cwd),
      unattended: true,
      origin: 'mcp-serve',
      maxPermissionMode: 'auto',
    }));
  });

  it('returns session summaries and Markdown evidence from the read-only tools', async () => {
    const cwd = tempDir();
    const server = await createMcpServer(
      { cwd, workspaces: [cwd], maxPermissionMode: 'auto' },
      {
        loadSession: async () => ({
          id: 'dc_read',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: realpathSync(cwd),
          summary: 'finished the task',
          messages: [{ role: 'assistant', content: 'done' }],
        }),
        latestRun: () => 'run_latest',
        renderReport: runId => `# Run Report — ${runId}\n`,
      },
    );

    const sessionResponse = await server.handleLine(request(1, 'tools/call', {
      name: 'dvalin_get_session', arguments: { session_id: 'dc_read' },
    }));
    expect(JSON.parse(toolPayload(sessionResponse).content[0].text)).toMatchObject({
      sessionId: 'dc_read', summary: 'finished the task', messageCount: 1,
    });

    const evidenceResponse = await server.handleLine(request(2, 'tools/call', {
      name: 'dvalin_get_evidence', arguments: {},
    }));
    expect(toolPayload(evidenceResponse).content[0].text).toContain('run_latest');
  });
});

// The spec makes version negotiation a MUST: reply with the requested version
// when it is supported, otherwise with one that is. Echoing an arbitrary
// string tells a newer client the server speaks a revision it has never
// implemented, and the client then relies on features that are absent.
describe('protocol version negotiation', () => {
  it('returns each revision this server actually speaks', () => {
    for (const version of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) {
      expect(negotiateProtocolVersion(version)).toBe(version);
    }
  });

  it('falls back to its own latest for a version it does not speak', () => {
    expect(negotiateProtocolVersion('2099-01-01')).toBe('2025-11-25');
    expect(negotiateProtocolVersion('1.0.0')).toBe('2025-11-25');
  });

  it('falls back when the client omits or malforms the field', () => {
    expect(negotiateProtocolVersion(undefined)).toBe('2025-11-25');
    expect(negotiateProtocolVersion(null)).toBe('2025-11-25');
    expect(negotiateProtocolVersion(20241105)).toBe('2025-11-25');
  });

  it('never echoes an unsupported version through initialize', async () => {
    const cwd = tempDir();
    const server = await createMcpServer({ cwd, workspaces: [cwd], maxPermissionMode: 'auto' });
    const response = await server.handleLine(
      request(1, 'initialize', { protocolVersion: '2099-01-01' }),
    );
    expect((response as any).result.protocolVersion).toBe('2025-11-25');
  });
});
