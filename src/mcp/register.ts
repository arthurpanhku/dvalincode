import { z } from 'zod';
import { checkMcpServer, PolicyViolationError, type ResolvedPolicy } from '../core/policy.js';
import type { AuditSink } from '../audit/log.js';
import type { Tool, ToolAccess } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpServerConfig } from './config.js';
import { McpClient, type McpToolDef, type McpCallResult } from './client.js';
import { McpStdioClient } from './stdio.js';
import type { McpEgressContext } from './governedFetch.js';
import { resolveHeaders, enabledRemoteServers, enabledLocalServers } from './config.js';

/** What a registered MCP tool needs from its transport, remote or local. */
export type McpToolCaller = {
  callTool(name: string, args: unknown, ctx: McpEgressContext): Promise<McpCallResult>;
};

/** Namespaced tool name — collision-proof and provenance-visible in the audit trail. */
export function mcpNamespacedName(serverId: string, toolName: string): string {
  return `mcp__${serverId}__${toolName}`;
}

/** Governance-first: only an explicitly read-only tool is `read`; everything else is the most-gated tier. */
function accessFor(def: McpToolDef): ToolAccess {
  return def.annotations?.readOnlyHint ? 'read' : 'execute';
}

function renderContent(result: McpCallResult): string {
  const parts = (result.content ?? []).map(c => (typeof c.text === 'string' ? c.text : `[${c.type}]`));
  const text = parts.join('\n').trim();
  if (text) return text;
  return result.isError ? '(MCP tool returned an error with no content)' : '(no content)';
}

/** Adapt one discovered MCP tool into a DvalinCode `Tool` that proxies `tools/call`. */
export function mcpToolToTool(serverId: string, def: McpToolDef, client: McpToolCaller): Tool<unknown> {
  return {
    name: mcpNamespacedName(serverId, def.name),
    description: def.description ?? `MCP tool "${def.name}" from server "${serverId}"`,
    access: accessFor(def),
    inputSchema: z.unknown(),
    parametersSchema: def.inputSchema ?? { type: 'object' },
    isConcurrencySafe: () => Boolean(def.annotations?.readOnlyHint),
    async run(input, context) {
      // Egress + audit are bound to the live per-run context here, so every
      // tools/call is checked against policy and recorded in this run's chain.
      const result = await client.callTool(def.name, input ?? {}, {
        policy: context.policy,
        audit: context.audit,
        serverId,
      });
      return {
        title: `MCP ${serverId}: ${def.name}`,
        output: renderContent(result),
        metadata: { server: serverId, tool: def.name, isError: Boolean(result.isError) },
      };
    },
  };
}

export type McpServerStatus = 'connected' | 'denied' | 'blocked' | 'error';

export type McpConnectionSummary = {
  id: string;
  status: McpServerStatus;
  tools: number;
  /** Which transport carried the connection — local servers never touch the network. */
  transport: 'http' | 'stdio';
  reason?: string;
};

export type McpRegistration = {
  summaries: McpConnectionSummary[];
  /** Stop every local server started for this run. Always call it when the turn ends. */
  dispose: () => void;
};

/**
 * Connect to each enabled + policy-permitted MCP server, discover its tools, and
 * register them into the registry.
 *
 * Remote servers are admitted by `checkMcpServer` and their egress is enforced by
 * the governed fetch. Local stdio servers are admitted by `checkMcpServer` *and*
 * `checkCommand` (in `McpStdioClient`), and run under the subprocess sandbox.
 * Either way, per-tool calls are enforced and audited against the live run later.
 */
export async function registerMcpServers(
  registry: ToolRegistry,
  servers: McpServerConfig[] | undefined,
  ctx: { policy: ResolvedPolicy; audit?: AuditSink; cwd: string },
): Promise<McpRegistration> {
  const summaries: McpConnectionSummary[] = [];
  const started: McpStdioClient[] = [];
  const dispose = () => {
    for (const client of started) client.close();
    started.length = 0;
  };

  for (const server of enabledRemoteServers(servers)) {
    const decision = checkMcpServer(ctx.policy, server.id);
    if (!decision.allowed) {
      summaries.push({ id: server.id, status: 'denied', tools: 0, transport: 'http', reason: decision.rule });
      continue;
    }

    const client = new McpClient({ id: server.id, url: server.url }, resolveHeaders(server.headers));
    const egress = { policy: ctx.policy, audit: ctx.audit, serverId: server.id };
    try {
      await client.initialize(egress);
      const tools = await client.listTools(egress);
      for (const def of tools) registry.register(mcpToolToTool(server.id, def, client));
      summaries.push({ id: server.id, status: 'connected', tools: tools.length, transport: 'http' });
    } catch (err) {
      const blocked = err instanceof PolicyViolationError;
      summaries.push({ id: server.id, status: blocked ? 'blocked' : 'error', tools: 0, transport: 'http', reason: errMsg(err) });
    }
  }

  for (const server of enabledLocalServers(servers)) {
    const decision = checkMcpServer(ctx.policy, server.id);
    if (!decision.allowed) {
      summaries.push({ id: server.id, status: 'denied', tools: 0, transport: 'stdio', reason: decision.rule });
      continue;
    }

    const client = new McpStdioClient({ id: server.id, command: server.command, args: server.args }, ctx.cwd);
    const egress = { policy: ctx.policy, audit: ctx.audit, serverId: server.id };
    try {
      await client.initialize(egress);
      started.push(client);
      const tools = await client.listTools(egress);
      for (const def of tools) registry.register(mcpToolToTool(server.id, def, client));
      summaries.push({ id: server.id, status: 'connected', tools: tools.length, transport: 'stdio' });
    } catch (err) {
      // A server that failed mid-handshake may still have a live process.
      client.close();
      const blocked = err instanceof PolicyViolationError;
      summaries.push({ id: server.id, status: blocked ? 'blocked' : 'error', tools: 0, transport: 'stdio', reason: errMsg(err) });
    }
  }

  return { summaries, dispose };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
