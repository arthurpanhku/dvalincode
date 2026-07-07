# Roadmap

**North Star:** make DvalinCode trivially approvable by any company's security review — controllable, transparent, auditable — while staying as convenient as any mainstream coding agent.

Every item below is governed by one architectural rule: *no capability may bypass the policy + audit chokepoints* (see [CONTRIBUTING.md](CONTRIBUTING.md) → "governance rules"). Design docs with acceptance matrices land in `docs/` before implementation.

Issues are the source of truth for status; this file is the map. Want one of these? Comment on its issue — most have a `help wanted` or `good first issue` label.

## Now (in progress / next up)

| Item | Why it matters | Ref |
|---|---|---|
| **Evidence Pack v1** | Turn governance claims into an offline-verifiable bundle (resolved policy + hash, audit chains, enforcement posture, run summaries) mapped to OpenSSF / ISO-42001 clauses. Evidence > claims — the highest-leverage step toward the North Star. | [#51](https://github.com/arthurpanhku/dvalincode/issues/51) |
| **Fix `run-tool` policy bypass** | The `run-tool` CLI entrypoint builds its context without `loadPolicy`, sidestepping org policy — a real governance gap. | [#45](https://github.com/arthurpanhku/dvalincode/issues/45) |
| **Durable-session transport wiring** | Engine-level crash recovery + idempotent replay exist; transports don't pass a stable `messageId` or surface recovered turns yet. | [#46](https://github.com/arthurpanhku/dvalincode/issues/46) · [#47](https://github.com/arthurpanhku/dvalincode/issues/47) |

## Next

| Item | Why it matters | Ref |
|---|---|---|
| **stdio / local MCP servers** | Local MCP without network egress — completes the MCP story beyond remote gateways. Same governed mapping as [GOVERNED-MCP.md](docs/GOVERNED-MCP.md). | [#52](https://github.com/arthurpanhku/dvalincode/issues/52) |
| **Structured approval engine** | Upgrade boolean approvals to scoped grants ("allow `npm test` for this run") — subject, scope, expiry, recorded in audit. | [#53](https://github.com/arthurpanhku/dvalincode/issues/53) |
| **Read-only Explore subagent** | Parallel read-only exploration that inherits the parent policy and gets its own audit chain linked to the parent run. | [#54](https://github.com/arthurpanhku/dvalincode/issues/54) |
| **Remediation worktree under the sandbox profile** | Close the documented exemption for the two local git calls (needs sandbox write access to the remediation dir first). | [#55](https://github.com/arthurpanhku/dvalincode/issues/55) |
| **MCP discovery audit anchoring** | Tool *calls* are audited per run; anchor the pre-run discovery connection into the chain as well. | [#56](https://github.com/arthurpanhku/dvalincode/issues/56) |

## Later

- **Native provider adapters** (Anthropic, Responses API) behind `governedProviderFetch` — reasoning, caching, structured output; model capability manifest + policy-driven model allowlists.
- **Windows subprocess network isolation** (currently honest fail-closed / `unavailable`).
- **ACP editor interop** — one adapter on `runAgentTurn` instead of N editor plugins.
- **Server-mediated enforcement** — hard policy custody beyond local tamper-evidence (the "A5" track in [APPROVABILITY-PLAN.md](docs/APPROVABILITY-PLAN.md)).

## Non-goals

Deliberate, not omissions:

- **In-process plugin loading** (from npm or local dirs) — arbitrary code inside the trust boundary is the opposite of approvable. Extensibility goes through governed MCP and skills.
- **Cloud sync / sharing services, marketplaces** — the value proposition is local-first custody.
- **Feature parity with large agent runtimes** — we compete on *approvability*, not surface area.
- **Persistent unattended PTY** — the one-shot, sandboxed shell is a security feature; long-lived interactive terminals need a governance design first.
