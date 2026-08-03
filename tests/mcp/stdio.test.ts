import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerMcpServers } from '../../src/mcp/register.js';
import { enabledLocalServers, parseMcpServerConfig } from '../../src/mcp/config.js';
import { permissivePolicy, resolvePolicy } from '../../src/core/policy.js';
import { selectSubprocessSandbox } from '../../src/core/subprocessSandbox.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createDvalinContext } from '../../src/core/context.js';
import type { AuditEvent, AuditSink } from '../../src/audit/log.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));
const CWD = path.dirname(FIXTURE);

function collector() {
  const events: AuditEvent[] = [];
  return { sink: { append: (e: AuditEvent) => events.push(e) } as unknown as AuditSink, events };
}

function localServer(overrides: Record<string, unknown> = {}) {
  return { id: 'echo', command: process.execPath, args: [FIXTURE], enabled: true, ...overrides };
}

afterEach(() => vi.unstubAllGlobals());

// ── config ───────────────────────────────────────────────────────────────────

describe('local MCP server config', () => {
  it('accepts a local stdio entry alongside remote entries', () => {
    expect(parseMcpServerConfig({ id: 'echo', command: 'node', args: ['server.mjs'], enabled: true }))
      .toMatchObject({ id: 'echo', command: 'node' });
  });

  it('selects only enabled local servers', () => {
    const servers = [
      { id: 'remote', url: 'https://example.test/mcp', enabled: true },
      { id: 'on', command: 'node', args: [], enabled: true },
      { id: 'off', command: 'node', args: [], enabled: false },
    ];
    expect(enabledLocalServers(servers).map(s => s.id)).toEqual(['on']);
  });
});

// ── the local transport works, without touching the network ──────────────────

describe('governed local MCP registration', () => {
  it('connects a local server over stdio and registers its tools', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const registry = new ToolRegistry();

    const { summaries, dispose } = await registerMcpServers(registry, [localServer()], {
      policy: permissivePolicy(),
      cwd: CWD,
    });
    try {
      expect(summaries[0]).toMatchObject({ id: 'echo', status: 'connected', tools: 2, transport: 'stdio' });
      expect(registry.list().map(t => t.name)).toEqual(['mcp__echo__echo', 'mcp__echo__touch_note']);
      // The entire point of stdio: a local server needs no egress at all.
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('derives the access tier from the tool annotations', async () => {
    const registry = new ToolRegistry();
    const { dispose } = await registerMcpServers(registry, [localServer()], {
      policy: permissivePolicy(),
      cwd: CWD,
    });
    try {
      const tools = Object.fromEntries(registry.list().map(t => [t.name, t.access]));
      expect(tools['mcp__echo__echo']).toBe('read');
      // Un-annotated third-party tools default to the most gated tier.
      expect(tools['mcp__echo__touch_note']).toBe('execute');
    } finally {
      dispose();
    }
  });

  it('proxies a tool call and audits it as a stdio mcp_request', async () => {
    const registry = new ToolRegistry();
    const { events, sink } = collector();
    const { dispose } = await registerMcpServers(registry, [localServer()], {
      policy: permissivePolicy(),
      cwd: CWD,
      audit: sink,
    });
    try {
      const context = createDvalinContext({ cwd: CWD, approvalMode: 'auto', policy: permissivePolicy(), audit: sink });
      const result = await registry.run('mcp__echo__echo', { text: 'hi' }, context);

      expect(result.output).toContain('called echo');
      const calls = events.filter(e => e.type === 'mcp_request' && e.tool === 'echo');
      expect(calls).toHaveLength(1);
      // Executable only — arguments never reach the audit trail.
      expect(calls[0]).toMatchObject({ server: 'echo', outcome: 'ok' });
      expect((calls[0] as { host: string }).host).toBe(`stdio:${path.basename(process.execPath)}`);
    } finally {
      dispose();
    }
  });
});

// ── bypass proofs ────────────────────────────────────────────────────────────

describe('local MCP cannot bypass policy', () => {
  it('refuses to launch a server whose command is denied, and audits the violation', async () => {
    const registry = new ToolRegistry();
    const { events, sink } = collector();

    // A local MCP entry must not become a side door around commands.deny.
    const policy = resolvePolicy([{ commands: { deny: ['node'] } }]);
    const { summaries, dispose } = await registerMcpServers(registry, [localServer()], {
      policy,
      cwd: CWD,
      audit: sink,
    });
    try {
      expect(summaries[0]).toMatchObject({ id: 'echo', status: 'blocked', tools: 0, transport: 'stdio' });
      expect(registry.list()).toHaveLength(0);
      expect(events.some(e => e.type === 'policy_violation' && e.tool === 'mcp:echo')).toBe(true);
      expect(events.some(e => e.type === 'mcp_request' && e.outcome === 'blocked')).toBe(true);
    } finally {
      dispose();
    }
  });

  it('does not launch a local server absent from the mcp allowlist', async () => {
    const registry = new ToolRegistry();
    const { events, sink } = collector();

    const { summaries, dispose } = await registerMcpServers(registry, [localServer({ id: 'evil' })], {
      policy: resolvePolicy([{ mcp: { allow: ['echo'] } }]),
      cwd: CWD,
      audit: sink,
    });
    try {
      expect(summaries[0]).toMatchObject({ id: 'evil', status: 'denied', tools: 0 });
      expect(registry.list()).toHaveLength(0);
      // Denied before admission: no process, so no request of any kind.
      expect(events.filter(e => e.type === 'mcp_request')).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it('still enforces the tool denylist on a registered local tool', async () => {
    const registry = new ToolRegistry();
    const policy = resolvePolicy([{ tools: { deny: ['mcp__echo__touch_note'] } }]);
    const { dispose } = await registerMcpServers(registry, [localServer()], { policy, cwd: CWD });
    try {
      const context = createDvalinContext({ cwd: CWD, approvalMode: 'auto', policy });
      await expect(registry.run('mcp__echo__touch_note', {}, context)).rejects.toThrow(/policy/i);
    } finally {
      dispose();
    }
  });

  it('requires real network isolation for a local server when egress is off', () => {
    // The sandbox decision is shared with the shell tool: no isolation available
    // means the launch fails closed rather than running unrestricted.
    const withoutSandbox = selectSubprocessSandbox('linux', true, {}, false);
    expect(withoutSandbox.allowed).toBe(false);

    const withSandbox = selectSubprocessSandbox('linux', true, { bwrapPath: '/usr/bin/bwrap' }, false);
    expect(withSandbox).toMatchObject({ allowed: true, sandbox: 'bwrap' });
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('local MCP lifecycle', () => {
  it('stops the server process when the run disposes it', async () => {
    const registry = new ToolRegistry();
    const { summaries, dispose } = await registerMcpServers(registry, [localServer()], {
      policy: permissivePolicy(),
      cwd: CWD,
    });
    expect(summaries[0]?.status).toBe('connected');

    dispose();

    const context = createDvalinContext({ cwd: CWD, approvalMode: 'auto', policy: permissivePolicy() });
    await expect(registry.run('mcp__echo__echo', { text: 'hi' }, context)).rejects.toThrow();
  });
});
