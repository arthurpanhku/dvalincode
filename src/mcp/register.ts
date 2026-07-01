import { z } from 'zod';
import { checkMcpServer, PolicyViolationError, type ResolvedPolicy } from '../core/policy.js';
import type { AuditSink } from '../audit/log.js';
import type { Tool, ToolAccess } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { McpServerConfig } from '../server/configStore.js';
import { McpClient, type McpToolDef, type McpCallResult } from './client.js';
import { resolveHeaders, enabledServers } from './config.js';

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
export function mcpToolToTool(serverId: string, def: McpToolDef, client: McpClient): Tool<unknown> {
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
  reason?: string;
};

/**
 * Connect to each enabled + policy-permitted MCP server, discover its tools, and
 * register them into the registry. Discovery egress is enforced by the governed
 * fetch; per-tool calls are enforced and audited against the live run later.
 */
export async function registerMcpServers(
  registry: ToolRegistry,
  servers: McpServerConfig[] | undefined,
  ctx: { policy: ResolvedPolicy; audit?: AuditSink },
): Promise<McpConnectionSummary[]> {
  const summaries: McpConnectionSummary[] = [];
  for (const server of enabledServers(servers)) {
    const decision = checkMcpServer(ctx.policy, server.id);
    if (!decision.allowed) {
      summaries.push({ id: server.id, status: 'denied', tools: 0, reason: decision.rule });
      continue;
    }

    const client = new McpClient({ id: server.id, url: server.url }, resolveHeaders(server.headers));
    const egress = { policy: ctx.policy, audit: ctx.audit, serverId: server.id };
    try {
      await client.initialize(egress);
      const tools = await client.listTools(egress);
      for (const def of tools) registry.register(mcpToolToTool(server.id, def, client));
      summaries.push({ id: server.id, status: 'connected', tools: tools.length });
    } catch (err) {
      const blocked = err instanceof PolicyViolationError;
      summaries.push({ id: server.id, status: blocked ? 'blocked' : 'error', tools: 0, reason: errMsg(err) });
    }
  }
  return summaries;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
