import { checkEgress, PolicyViolationError, type ResolvedPolicy } from '../core/policy.js';
import type { AuditSink } from '../audit/log.js';

export type McpEgressContext = {
  policy: ResolvedPolicy;
  audit?: AuditSink;
  serverId: string;
};

/**
 * The one network path for MCP. Every request to a server passes through here so
 * egress is enforced and audited before any third-party connection is made. An
 * MCP gateway is **not** the model endpoint, so `checkEgress(policy, false)`
 * blocks it under `network: off` / `endpoint-only`. Auth headers and bodies are
 * never logged — the audit record carries only server, tool, host, outcome, and
 * duration.
 */
export async function governedMcpFetch(
  url: string,
  init: RequestInit,
  ctx: McpEgressContext,
  tool: string,
): Promise<Response> {
  const host = safeOrigin(url);
  const started = Date.now();

  const decision = checkEgress(ctx.policy, false);
  if (!decision.allowed) {
    ctx.audit?.append({ type: 'mcp_request', server: ctx.serverId, tool, host, outcome: 'blocked', durationMs: Date.now() - started });
    ctx.audit?.append({ type: 'policy_violation', rule: decision.rule, tool: `mcp:${ctx.serverId}`, target: host });
    throw new PolicyViolationError(`mcp:${ctx.serverId}`, decision.rule, host);
  }

  try {
    const res = await fetch(url, init);
    ctx.audit?.append({
      type: 'mcp_request',
      server: ctx.serverId,
      tool,
      host,
      outcome: res.ok ? 'ok' : 'error',
      durationMs: Date.now() - started,
    });
    return res;
  } catch (err) {
    ctx.audit?.append({ type: 'mcp_request', server: ctx.serverId, tool, host, outcome: 'error', durationMs: Date.now() - started });
    throw err;
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}
