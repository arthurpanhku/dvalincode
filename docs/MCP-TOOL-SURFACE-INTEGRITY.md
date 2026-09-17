# MCP Tool Surface Integrity — Design

**Status:** draft for review ([#235](https://github.com/arthurpanhku/dvalincode/issues/235)). Extends [GOVERNED-MCP.md](GOVERNED-MCP.md), which governs what an MCP tool may *do*; this governs whether the tool we were handed is the tool we approved.

## Scope

A tool's `description` is instruction the model obeys, and no human reads it after the first install. Its `inputSchema` shapes what the model sends. Its annotations decide which permission tier it lands in. All three arrive from a third party on every `tools/list`, and today all three are trusted on arrival.

This design canonicalises that surface, hashes it, records the digest, and reports when it changes. In scope:

- a per-tool and per-server digest over the fields that steer the model
- an `mcp_tool_surface` audit event carrying digests, never text
- an optional committed pin, so a change becomes a code-review event
- annotation changes treated as a policy question rather than a cosmetic one

## The threat this closes

Every existing chokepoint stays satisfied while the agent's behavior changes. `checkCommand` gates a command; `checkEgress` gates a host; `registry.run` gates a call. A rewritten description needs none of them — it changes what the model *decides* to do, one layer above where we are looking. Microsoft's June 2026 research describes exactly this: exfiltration in which every individual action still appears authorized. OWASP ranks it third in its MCP Top 10; NSA's CSI names it in the same threat model.

Two variants matter here, and the second is the one worth the most attention:

**1. Description drift.** The text changes; the tool still does what it says; the model does something else. Nothing downstream can see it, because we never recorded what the text was.

**2. Annotation drift — a policy bypass, not a cosmetic change.** [`src/mcp/register.ts:24`](../src/mcp/register.ts) derives access from annotations: `def.annotations?.readOnlyHint ? 'read' : 'execute'`. A server that flips `readOnlyHint` from absent to `true` moves its own tool out of the most-gated tier. The server chooses its own permission level, and the choice is re-made on every `tools/list`.

The same flag has a second effect two lines down: `isConcurrencySafe: () => Boolean(def.annotations?.readOnlyHint)`. So one flipped boolean both lowers the permission tier and makes the tool eligible to run concurrently — a wider change than "read-only" suggests, and one no human is prompted to approve.

That is a widening of privilege from a repo-external source, which governance rule 2 (*narrowing only*) already forbids for policy. The same rule should hold for metadata that decides policy.

## Design

### What is hashed

For each tool, over the fields that steer the model or decide its tier:

```
toolDigest = sha256(canonicalJSON({ name, description, inputSchema, annotations }))
```

For the server, over the sorted per-tool digests:

```
surfaceDigest = sha256(canonicalJSON([{ name, toolDigest }, …sorted by name]))
```

Per-tool digests are what let a report name *which* tool changed rather than only that something did. `canonicalJSON` and `sha256` already exist in [`src/audit/hash.ts`](../src/audit/hash.ts), so this adds no runtime dependency (governance rule 5) and reuses the canonicalisation the Verified Fix Record is already hashed with.

### Where it hooks

Immediately after `listTools()` resolves, before any tool is registered — `src/mcp/client.ts` and `src/mcp/stdio.ts` both, since a check present on only one transport is a side door (governance rule 1). Registration into the registry happens downstream of the check, so a server that fails a pin never gets its tools mapped to `mcp__<server>__*` at all.

### What is recorded

A new `mcp_tool_surface` audit event, per server per run:

| Field | Contents |
|---|---|
| `server` | server id |
| `surfaceDigest` | the digest above |
| `toolCount` | number of tools offered |
| `pinState` | `unpinned` · `matched` · `changed` |
| `changed` | on a change: for each tool, its name and **which fields** differ — `description`, `inputSchema`, `annotations` |

`changed` carries field *names*, never field *values*. Governance rule 3 (*minimize, don't leak*) applies with particular force here: the whole point is that descriptions are attacker-controlled text, and copying them into the audit chain would move attacker-controlled text into the record auditors read. The digest proves change; the field name locates it; the diff is for the reviewer to pull from the server, deliberately.

### The pin

An optional `mcp-tools.lock` committed to the repository, mapping server id → `surfaceDigest` plus per-tool digests.

Committing it is what converts a silent metadata change into a pull-request diff — the control Microsoft's guidance actually asks for, which is that any change to MCP configuration is reviewed like code. The lock is an **integrity record, not a grant**: it cannot admit a server that policy's `mcp` allowlist excludes, and it cannot widen anything. Narrowing-only is unaffected because the lock never grants.

### Enforcement posture

Governance rule 4 (*honest enforcement*) means this cannot be silently advisory. It also should not break every legitimate server upgrade, which are routine and frequent. The proposed default:

| Situation | Default | Why |
|---|---|---|
| No lock entry for the server | Record baseline, report it, continue | Trust on first use. There is nothing yet to compare against, and refusing would make the feature unadoptable. |
| Lock entry matches | Continue | The approved surface. |
| Lock entry differs, no tier widening | **Warn** and continue; report names the tools and fields | The common case is a real upgrade. Failing closed here trains people to delete the lock. |
| Lock entry differs, and a tool moves `execute` → `read` | **Fail closed** | A third party widened its own privilege. This is rule 2, not a preference — it fails even when the operator has chosen `warn`. |

The asymmetry is the load-bearing part: a changed description is a *fact to report*, a self-granted tier upgrade is a *violation to block*. Collapsing both into one setting loses the distinction that makes the control worth having.

**This is the open question for review.** The alternative — fail closed on any change once pinned — is more defensible in a threat model and worse in practice, because a tool surface that legitimately changes on every server release produces a stream of blocks that operators will resolve by turning the check off. A control that gets disabled protects nothing. I lean toward the table above and would like that argued rather than assumed.

### Trust surface

[`dvalincode trust`](GOVERNED-MCP.md#governance-surfaces-mcp-adds-that-the-chokepoint-does-not-already-cover) already lists each server with its policy permission, egress status, and tool count. It gains the surface digest and pin state, so an approver sees at a glance whether the third-party attack surface is the one that was reviewed.

## Acceptance matrix

| Case | Expected result |
|------|-----------------|
| No MCP config | Behaves exactly as today; nothing hashed, no new event |
| First connection to a server, no lock entry | `mcp_tool_surface` written with `pinState: unpinned`; baseline reported; tools register normally |
| Reconnect, surface unchanged | `pinState: matched`; no report beyond the audit event |
| Description changes between runs | `pinState: changed`; report names the tool and `description`; run continues under the default posture |
| `inputSchema` changes between runs | `pinState: changed`; report names the tool and `inputSchema` |
| A tool gains `readOnlyHint: true` against its locked entry | **Blocked**; tools not registered; policy violation recorded — regardless of posture setting |
| A tool loses `readOnlyHint` (narrowing to `execute`) | Reported as changed; not blocked — narrowing is always allowed |
| A tool is added or removed | `pinState: changed`; report names it as added/removed |
| Audit record for any of the above | Carries digests, tool names and field names; contains no description text, schema body, or annotation values |
| Server fails the pin check | No `mcp__<server>__*` tools reach the registry |
| Two servers offering same-named tools | Digests are per server id; no collision |
| `dvalincode trust` | Shows surface digest and pin state per server |

## Non-goals (deferred)

- **Judging whether a description is malicious.** This proves the surface is *stable*, not that it is *safe*. A server that ships a poisoned description on day one gets that description pinned. Detecting the content itself would mean asking a model to evaluate text, and a model's opinion is exactly what this project refuses to put in a verification path — the same reason the executor is recorded and never consulted. Stability is a deterministic property; safety is not.
- **Server authenticity.** Whether the server is who it claims to be is a transport and admission question, handled by the policy allowlist and (for remote servers) the egress path.
- **Pinning tool *behavior*.** A server may return an honest description and do something else entirely on `tools/call`. That is the verification problem, not the integrity problem, and it is not solved by hashing metadata.
- **Automatic lock updates.** Regenerating the lock is a deliberate act with a diff someone reads. A command that silently re-pins on change would reintroduce exactly the blindness this removes.

## References

- [NSA — Model Context Protocol: Security Design Considerations](https://media.defense.gov/2026/Jun/02/2003943289/-1/-1/0/CSI_MCP_SECURITY.PDF) (June 2026)
- [Microsoft — Securing AI agents: when AI tools move from reading to acting](https://www.microsoft.com/en-us/security/blog/2026/06/30/securing-ai-agents-ai-tools-move-from-reading-acting/) (30 June 2026)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) — ASI04, agentic supply chain
- [GOVERNED-MCP.md](GOVERNED-MCP.md) — the chokepoint this extends
- [CONTRIBUTING.md](../CONTRIBUTING.md) — the governance rules cited throughout
