import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../../src/mcp/client.js';
import { mcpToolToTool, registerMcpServers } from '../../src/mcp/register.js';
import { resolveHeaders } from '../../src/mcp/config.js';
import { governedMcpFetch } from '../../src/mcp/governedFetch.js';
import { permissivePolicy, resolvePolicy, PolicyViolationError } from '../../src/core/policy.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createDvalinContext } from '../../src/core/context.js';
import type { AuditEvent, AuditSink } from '../../src/audit/log.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function collector() {
  const events: AuditEvent[] = [];
  const sink = { append: (e: AuditEvent) => events.push(e) } as unknown as AuditSink;
  return { sink, events };
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
}

const SEARCH_DEF = {
  name: 'search',
  description: 'Search docs',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
const WRITE_DEF = { name: 'write_note', description: 'Write a note', inputSchema: { type: 'object' } };

function mockServer(): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string | URL, init: RequestInit) => {
    const req = JSON.parse(init.body as string) as { id?: number; method: string; params?: any };
    switch (req.method) {
      case 'initialize':
        return jsonResponse(
          { jsonrpc: '2.0', id: req.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'mock' } } },
          { 'mcp-session-id': 'sess-1' },
        );
      case 'notifications/initialized':
        return new Response(null, { status: 202 });
      case 'tools/list':
        return jsonResponse({ jsonrpc: '2.0', id: req.id, result: { tools: [SEARCH_DEF, WRITE_DEF] } });
      case 'tools/call':
        return jsonResponse({
          jsonrpc: '2.0',
          id: req.id,
          result: { content: [{ type: 'text', text: `called ${req.params.name} args=${JSON.stringify(req.params.arguments)}` }] },
        });
      default:
        return jsonResponse({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
    }
  });
}

const egress = (policy = permissivePolicy(), audit?: AuditSink) => ({ policy, audit, serverId: 'glama' });

afterEach(() => vi.unstubAllGlobals());

// ── config ─────────────────────────────────────────────────────────────────

describe('mcp config', () => {
  it('resolves ${ENV} placeholders in headers from the environment', () => {
    process.env.TEST_MCP_KEY = 'secret-123';
    expect(resolveHeaders({ Authorization: 'Bearer ${TEST_MCP_KEY}' })).toEqual({ Authorization: 'Bearer secret-123' });
    delete process.env.TEST_MCP_KEY;
  });
});

// ── client protocol ──────────────────────────────────────────────────────────

describe('McpClient (Streamable HTTP)', () => {
  it('initializes, lists tools, and proxies a call (JSON transport)', async () => {
    const fetchMock = mockServer();
    vi.stubGlobal('fetch', fetchMock);
    const client = new McpClient({ id: 'glama', url: 'https://glama.ai/mcp/x' }, {});

    await client.initialize(egress());
    const tools = await client.listTools(egress());
    expect(tools.map(t => t.name)).toEqual(['search', 'write_note']);

    const result = await client.callTool('search', { q: 'hello' }, egress());
    expect(result.content?.[0]?.text).toContain('called search args={"q":"hello"}');

    // Session id from initialize is echoed on later requests.
    const listCall = fetchMock.mock.calls.find(c => JSON.parse(c[1].body).method === 'tools/list');
    expect((listCall![1].headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess-1');
  });

  it('reads a JSON-RPC response delivered as an SSE stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const req = JSON.parse(init.body as string);
      if (req.method === 'initialize') return jsonResponse({ jsonrpc: '2.0', id: req.id, result: {} });
      if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [SEARCH_DEF] } })}\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }));
    const client = new McpClient({ id: 'glama', url: 'https://glama.ai/mcp/x' }, {});
    await client.initialize(egress());
    const tools = await client.listTools(egress());
    expect(tools[0].name).toBe('search');
  });
});

// ── egress governance ────────────────────────────────────────────────────────

describe('governed MCP egress', () => {
  it('blocks the connection under network: off and never calls fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { sink, events } = collector();
    const off = resolvePolicy([{ network: 'off' }]);

    await expect(
      governedMcpFetch('https://glama.ai/mcp/x', { method: 'POST' }, egress(off, sink), 'initialize'),
    ).rejects.toBeInstanceOf(PolicyViolationError);

    expect(fetchMock).not.toHaveBeenCalled();
    const req = events.find(e => e.type === 'mcp_request');
    expect(req).toMatchObject({ type: 'mcp_request', server: 'glama', host: 'https://glama.ai', outcome: 'blocked' });
    expect(events.some(e => e.type === 'policy_violation')).toBe(true);
  });

  it('blocks under endpoint-only (an MCP gateway is not the model endpoint)', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const ep = resolvePolicy([{ network: 'endpoint-only' }]);
    await expect(
      governedMcpFetch('https://glama.ai/mcp/x', { method: 'POST' }, egress(ep), 'tools/call'),
    ).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it('audits a successful call without leaking auth headers, args, or body', async () => {
    vi.stubGlobal('fetch', mockServer());
    const { sink, events } = collector();
    const client = new McpClient({ id: 'glama', url: 'https://glama.ai/mcp/x' }, { Authorization: 'Bearer secret-xyz' });
    await client.initialize(egress(permissivePolicy(), sink));
    await client.callTool('search', { q: 'sensitive query' }, egress(permissivePolicy(), sink));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('secret-xyz');
    expect(serialized).not.toContain('sensitive query');
    const call = events.filter(e => e.type === 'mcp_request');
    expect(call.every(e => (e as any).outcome === 'ok')).toBe(true);
    expect(call.some(e => (e as any).tool === 'search')).toBe(true);
  });
});

// ── tool adapter + registry ──────────────────────────────────────────────────

describe('mcp tool adapter', () => {
  it('maps annotations to access and namespaces the tool name', () => {
    const client = new McpClient({ id: 'glama', url: 'https://x' }, {});
    const read = mcpToolToTool('glama', SEARCH_DEF, client);
    const write = mcpToolToTool('glama', WRITE_DEF, client);
    expect(read.name).toBe('mcp__glama__search');
    expect(read.access).toBe('read');
    expect(read.parametersSchema).toEqual(SEARCH_DEF.inputSchema);
    // Un-annotated tools default to the most-gated tier.
    expect(write.access).toBe('execute');
  });

  it('is blocked by tools.deny at the registry chokepoint like any other tool', async () => {
    vi.stubGlobal('fetch', mockServer());
    const registry = new ToolRegistry();
    const client = new McpClient({ id: 'glama', url: 'https://glama.ai/mcp/x' }, {});
    registry.register(mcpToolToTool('glama', SEARCH_DEF, client));

    const denied = createDvalinContext({
      approvalMode: 'full-auto',
      policy: resolvePolicy([{ tools: { deny: ['mcp__glama__search'] } }]),
    });
    await expect(registry.run('mcp__glama__search', { q: 'x' }, denied)).rejects.toBeInstanceOf(PolicyViolationError);
  });
});

// ── server admission ──────────────────────────────────────────────────────────

describe('registerMcpServers admission', () => {
  it('does not connect a server absent from the policy mcp allowlist', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ToolRegistry();
    const summaries = await registerMcpServers(
      registry,
      [{ id: 'evil', url: 'https://evil.example/mcp', enabled: true }],
      { policy: resolvePolicy([{ mcp: { allow: ['glama'] } }]) },
    );
    expect(summaries[0]).toMatchObject({ id: 'evil', status: 'denied', tools: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(0);
  });

  it('skips disabled servers entirely', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ToolRegistry();
    const summaries = await registerMcpServers(
      registry,
      [{ id: 'glama', url: 'https://glama.ai/mcp/x', enabled: false }],
      { policy: permissivePolicy() },
    );
    expect(summaries).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('connects an allowed server and registers its tools', async () => {
    vi.stubGlobal('fetch', mockServer());
    const registry = new ToolRegistry();
    const summaries = await registerMcpServers(
      registry,
      [{ id: 'glama', url: 'https://glama.ai/mcp/x', enabled: true }],
      { policy: permissivePolicy() },
    );
    expect(summaries[0]).toMatchObject({ id: 'glama', status: 'connected', tools: 2 });
    expect(registry.list().map(t => t.name)).toEqual(['mcp__glama__search', 'mcp__glama__write_note']);
  });
});
