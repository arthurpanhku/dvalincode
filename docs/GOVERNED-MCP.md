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

v1 was a thin, demonstrable vertical slice covering remote servers only. Local
stdio servers were added afterwards under the same contract — see
[Local stdio servers](#local-stdio-servers). Neither adds OAuth/dynamic client
registration, resources/prompts/sampling, or a second policy engine.

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

## Local stdio servers

A local server runs as a child process and exchanges newline-delimited JSON-RPC
over its stdin/stdout (`src/mcp/stdio.ts`). No network is involved, which is the
point: a local server stays usable under `network: off`, where a remote gateway
is correctly blocked. Tool mapping, access tiers, `tools.deny`, and the
`mcp_request` audit event are identical to the remote transport.

Two governance surfaces are specific to it:

6. **Command admission.** Starting a server *is* command execution, and it
   happens at registration time — before any tool call exists for `registry.run`
   to gate. The registry's `checkCommand` chokepoint therefore does not cover it,
   so `McpStdioClient` applies `checkCommand` itself against
   `"<command> <args…>"` before spawning. Without this, `mcp.servers` would be a
   side door around the shell-command denylist. A denial spawns nothing and
   records both a blocked `mcp_request` and a `policy_violation`.
7. **Process isolation.** The child is launched through `spawnGovernedSession`,
   which reuses the shell tool's sandbox decision: a policy that forbids egress
   puts the server behind Seatbelt (macOS) or Bubblewrap (Linux), and **fails
   closed** where neither is available (notably Windows). Under `network: on`
   the server runs unisolated, exactly like a governed shell command.

Local servers are per-run child processes: `registerMcpServers` returns a
`dispose()` that the turn runner calls in a `finally`, so no server outlives the
turn that started it.

> **Residual risk (honest).** Under `network: on`, a local MCP server is an
> ordinary local process and may open its own network connections. DvalinCode
> neither sees nor audits that traffic — `mcp_request` records the JSON-RPC call,
> not what the server does with it. The controls that bound this are the command
> allowlist (which servers may start at all), the `mcp` allowlist, and running
> under `network: off` when a server must stay sealed. Reviewers should treat a
> local MCP server as trusted code, on par with anything else on `PATH`.

## Audit for a local server

`mcp_request.host` carries `stdio:<executable>` — the executable's basename only,
never its arguments — matching how `shell_exec` records `command`. A reader can
therefore tell local calls from remote ones, and which binary served them,
without the record leaking paths or parameters.

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

A local stdio server is configured with `command` + `args` instead of `url`:

```jsonc
{
  "mcp": {
    "servers": [
      {
        "id": "notes",
        "command": "npx",
        "args": ["-y", "@example/mcp-notes"],
        "enabled": true
      }
    ]
  }
}
```

The two shapes may be mixed in one `servers` array; each entry is validated
against its own schema at the configuration boundary.

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
| Local server, allowed command, `network: on` | Connects over stdio; tools registered; **no** `fetch` is issued |
| Local server whose command matches `commands.deny` | Nothing is spawned; blocked `mcp_request` + `policy_violation` recorded |
| Local server, `network: off`, sandbox available | Runs network-isolated (Seatbelt/Bubblewrap) and stays usable |
| Local server, `network: off`, no sandbox available | Launch fails closed rather than running unrestricted |
| Turn ends (success, error, or interrupt) | `dispose()` stops every local server started for that run |

## Non-goals (deferred)

- OAuth, dynamic client registration, managed credentials.
- MCP resources, prompts, sampling, roots, notifications.
- Per-tool host allowlists beyond the `network` level (a future narrowing rule).
- Relying on the gateway's own access control in place of local policy.
