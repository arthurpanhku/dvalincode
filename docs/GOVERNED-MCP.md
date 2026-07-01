# Governed MCP v1 Design

## Scope

Add a **remote Model Context Protocol (MCP) client** so DvalinCode can use tools
exposed by remote MCP servers and gateways — in particular
[Glama](https://glama.ai/), which fronts thousands of MCP servers behind a single
Streamable-HTTP endpoint with `Authorization: Bearer` auth.

The point of this slice is not "MCP support" — it is **governed** MCP support.
Glama (and any gateway) governs the *server* side. DvalinCode's job is
**client-side governance**: the org policy bounds what the agent may do with those
tools, the tamper-evident audit records every call, and the egress guard controls
the third-party network connection. **We never outsource trust to the gateway.**

v1 is a thin, demonstrable vertical slice. It does **not** add stdio/local
servers, OAuth/dynamic client registration, resources/prompts/sampling, or a
second policy engine.

## Transport

Remote **Streamable HTTP** (the transport the MCP spec standardized in 2025):
JSON-RPC 2.0 over HTTP POST, with responses returned either as a single
`application/json` body or as a `text/event-stream` (SSE) carrying the response
message. Session continuity via the `Mcp-Session-Id` header. Auth via
caller-supplied headers (`Authorization: Bearer ${ENV}`).

Hand-rolled (no SDK dependency) to preserve DvalinCode's zero-runtime-deps
posture. Only three JSON-RPC methods are needed for v1: `initialize`,
`tools/list`, `tools/call`.

## Mapping MCP tools onto the governance chokepoint

Each MCP tool becomes an ordinary DvalinCode `Tool`, so it inherits the single
`registry.run` policy + permission + audit chokepoint automatically:

- **Name**: `mcp__<serverId>__<toolName>` — namespaced to prevent collisions and
  to make provenance visible in the audit trail and `tools.deny` rules.
- **Access**: derived from the MCP tool's annotations — `readOnlyHint: true`
  maps to `read`; everything else defaults to `execute` (the most gated tier).
  Governance-first: an un-annotated third-party tool is treated as the most
  dangerous, not the least.
- **`run`**: proxies a `tools/call` to the server through the governed fetch.
- Registered into the default registry, so `checkTool` (denylist), permission by
  access, the auto-edit approval gate, and `emitToolAudit` all apply unchanged.

## Governance surfaces MCP adds (that the chokepoint does not already cover)

1. **Egress.** Connecting to the gateway and every `tools/call` is outbound
   network to a third party. It is routed through a governed fetch that runs
   `checkEgress(policy, /*isModelEndpoint*/ false)` **before** the request and
   audits an `mcp_request` event. Consequence: under `network: off` or
   `endpoint-only`, MCP is **blocked** — a third-party gateway is not the model
   endpoint, so "only talk to the model" correctly denies it. MCP requires
   `network: on` in v1 (a host allowlist is future work).
2. **Server admission.** Policy gains an `mcp` dimension: a server-id allowlist
   resolved by narrowing (repo can only tighten machine). A configured server not
   in the allowlist is not connected.
3. **Credential minimization.** Auth headers come from `${ENV}` at call time and
   are **never** persisted — not in audit, not in the run report. `mcp_request`
   records only server, tool, host, outcome, and duration; never headers, args,
   or response bodies.
4. **Trust surface.** `dvalincode trust` lists configured MCP servers, whether
   each is permitted by policy, its egress status under the current network
   level, and how many tools it exposes — so an approver sees the third-party
   attack surface at a glance.
5. **Off by default.** MCP servers are opt-in (`enabled: true` in config) and
   gated by policy + network. A run with no MCP config behaves exactly as today —
   no new egress, no latency.

> **Forward guardrail.** Every MCP network call must go through the governed
> fetch (`checkEgress` + audit). A direct `fetch` to a server is a new ungoverned
> egress path and a release blocker — the same rule as provider adapters
> (see EGRESS-THREAT-MODEL.md).

## Configuration

```jsonc
// mcp config (resolved from the existing config store)
{
  "mcp": {
    "servers": [
      {
        "id": "glama",
        "url": "https://glama.ai/mcp/<endpoint>",
        "headers": { "Authorization": "Bearer ${GLAMA_API_KEY}" },
        "enabled": true
      }
    ]
  }
}
```

`${ENV}` placeholders in header values are resolved from the process
environment at connect time; the raw secret never touches disk via DvalinCode.

## Acceptance matrix

| Case | Expected result |
|------|-----------------|
| No MCP config | Behaves exactly as today; no connection, no egress |
| Configured + enabled server, `network: on`, allowed by policy | `tools/list` maps to `mcp__<server>__*` tools registered in the registry |
| A mapped tool is invoked | `tools/call` is proxied and an `mcp_request` audit event is written |
| `network: off` or `endpoint-only` | Connection/call blocked by `checkEgress`; a policy violation is recorded |
| Server not in the policy `mcp` allowlist | Server is not connected; its tools are not registered |
| `tools.deny` lists `mcp__<server>__<tool>` | That tool is blocked at the chokepoint like any other |
| Read-only annotated tool | Registered with `access: read`; un-annotated tool defaults to `execute` |
| Audit for an MCP call | Contains server/tool/host/outcome/duration; no `Authorization`, args, or response body |
| Trust report | Lists configured servers, policy permission, egress status, tool count |

## Non-goals (deferred)

- stdio / local MCP servers.
- OAuth, dynamic client registration, managed credentials.
- MCP resources, prompts, sampling, roots, notifications.
- Per-tool host allowlists beyond the `network` level (a future narrowing rule).
- Relying on the gateway's own access control in place of local policy.
