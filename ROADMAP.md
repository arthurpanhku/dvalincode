# Roadmap

**North Star:** make DvalinCode trivially approvable by any company's security review — controllable, transparent, auditable — while staying as convenient as any mainstream coding agent.

**Core goal:** *every repair carries its own independent proof.* As more code is
written by agents, the scarce thing stops being a fix and becomes a reason to
believe one. Dvalin decides whether a repair worked without asking whoever wrote
it, and issues that decision as a record anyone can re-derive offline — for a
repair written by our agent, by Claude Code, by Codex, or by a person.
[FVP-1 →](docs/spec/FIX-VERIFICATION.md)

Every item below is governed by one architectural rule: *no capability may bypass the policy + audit chokepoints* (see [CONTRIBUTING.md](CONTRIBUTING.md) → "governance rules"). Design docs with acceptance matrices land in `docs/` before implementation.

Issues are the source of truth for status; this file is the map. Want one of these? Comment on its issue — most have a `help wanted` or `good first issue` label.

## Recently shipped ✅

- **Verification carried to the surfaces that produce repairs** — the GitHub Action re-derives a fix record on the runner from the file alone and posts the result beside the diff, so a reviewer need not trust the pipeline that produced it; every scan comment states what the scan covered. The server route now goes through `executeSecurityScan` rather than around it, which unblocked both GUIs: the web UI (and the desktop webview over it) renders a coverage badge instead of a hand-written caveat, and a zero-finding scan with `partial` coverage is no longer presented as a clean result. The TUI and both CLIs report the same thing. [Plan →](docs/VERIFICATION-SURFACES-PLAN.md)
- **Editor distribution** — the VS Code extension is published to the Marketplace and Open VSX, and `dvalincode mcp-install <editor>` writes the MCP config for Cursor, VS Code, or Claude Code in one command. `harness-interop.yml` checks weekly that the real harness CLIs can still drive the MCP server.
- **Verified Fix Record** — the three verification paths (`--fix --verify`, `dvalin verify`, and the MCP server) now share one implementation that re-scans, runs the project's own checks, and reads the exit codes itself. The result is a portable record — targets before and after, commands and observed exit codes, coverage on both sides, an audit-chain anchor, a hash over canonical JSON — re-derivable offline with `dvalin verify-fix` or the `dvalin_verify_fix` MCP tool. The executor is recorded and never consulted. [FVP-1 →](docs/spec/FIX-VERIFICATION.md)
- **Honest scan coverage** — every scan reports `complete` / `partial` / `unknown`, and a baseline finding whose engine did not run is now reported as `unknown` rather than as *resolved*. Absent because unlooked-for is not absent because fixed.
- **FVP-1, an open profile** — the fix-verification contract (executor/verifier separation, observed exit codes, re-derivable records, coverage honesty) published as a vendor-neutral spec any security tool can implement and be held to, this one included.
- **stdio / local MCP servers** ([#52](https://github.com/arthurpanhku/dvalincode/issues/52)) — local MCP without any network egress, so a server stays usable under `network: off`. Starting one is command execution that happens outside `registry.run`, so it is gated by `checkCommand` before spawn and runs under the shell tool's subprocess sandbox; servers are per-run children stopped when the turn ends. [Design →](docs/GOVERNED-MCP.md#local-stdio-servers)
- **Release Evidence Pack** — every release now ships `dvalincode-v<version>-evidence.json`, produced by the shipped binary from two real governed runs (one allowed, one blocked by policy) and re-verifiable offline before you install anything. [Design →](docs/RELEASE-EVIDENCE.md)
- **PCP-1, an open profile** — the provider-boundary contract ([egress, credentials, audit, policy binding](docs/spec/PROVIDER-CONFORMANCE.md)) published as a vendor-neutral spec any agent runtime can implement and report against, not just a DvalinCode test file.
- **Evidence Pack v1** ([#51](https://github.com/arthurpanhku/dvalincode/issues/51)) — offline-verifiable governance bundle (resolved policy + hash, audit chains, enforcement posture) mapped to OpenSSF / ISO-42001 clauses.
- **`run-tool` policy bypass fixed** ([#45](https://github.com/arthurpanhku/dvalincode/issues/45)) — the CLI entrypoint now resolves org policy like every other surface.
- **Durable-session transport wiring** ([#46](https://github.com/arthurpanhku/dvalincode/issues/46) · [#47](https://github.com/arthurpanhku/dvalincode/issues/47)) — stable `messageId` for idempotent replay, plus recovered-turn notices in the TUI and web UI.
- **Governed harness mode** ([#115](https://github.com/arthurpanhku/dvalincode/pull/115)) — headless runs, an MCP server surface, and the unattended permission tier.

## Now / next up

| Item | Why it matters | Ref |
|---|---|---|
| **Fix-verification adoption — last two surfaces** | The record is now the visible output of a repair on the pull request, in the CLI, the TUI, the MCP server, the server route, and both GUIs. Two surfaces still cannot see it: the VS Code extension shows findings with no statement of what the scan covered, and headless runs emit no coverage or fix record at all — the surface with no human to notice the omission. | [#204](https://github.com/arthurpanhku/dvalincode/issues/204) · [#205](https://github.com/arthurpanhku/dvalincode/issues/205) · [Plan](docs/VERIFICATION-SURFACES-PLAN.md) · [FVP-1](docs/spec/FIX-VERIFICATION.md) |
| **Provider adapter conformance suite** | The executable half of [PCP-1](docs/spec/PROVIDER-CONFORMANCE.md) — the shared contract every provider must pass (egress containment, credential containment, audit, policy binding). Turns "should we trust a new provider?" into an objective gate. | [#118](https://github.com/arthurpanhku/dvalincode/issues/118) |
| **Structured approval engine** | Upgrade boolean approvals to scoped grants ("allow `npm test` for this run") — subject, scope, expiry, recorded in audit. | [#53](https://github.com/arthurpanhku/dvalincode/issues/53) |
| **Harness-mode + unattended-tier test coverage** | Pin the most governance-sensitive path (no human in the loop) with bypass-proof tests. | [#119](https://github.com/arthurpanhku/dvalincode/issues/119) |

## Next

| Item | Why it matters | Ref |
|---|---|---|
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
- **An AI-native detection engine** — reasoning models as the primary scanner is a well-funded race we would enter last and with the least data. Dvalin stays engine-neutral: it orchestrates whatever engines you have, and competes on the evidence and verification layer above them, where the executor of a repair is not also its judge.
- **Persistent unattended PTY** — the one-shot, sandboxed shell is a security feature; long-lived interactive terminals need a governance design first.
