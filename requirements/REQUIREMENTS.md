# DvalinCode Requirements

> Auto-generated from community intelligence pipeline.
> Last updated: 2026-05-21

## Priority Framework (First Principles)

Every feature is scored on 5 dimensions (1-5):

| Dimension | Description |
|-----------|-------------|
| **Pain** | How many users complain? How loud? |
| **Alignment** | Does this fit our design philosophy (local-first, zero deps, provider-neutral)? |
| **Cost** | Implementation complexity (5=trivial, 1=hard) |
| **Risk** | Could it break existing functionality? (5=safe, 1=high risk) |
| **Gap** | How far behind are we vs Codex/Claude Code? (5=way behind, 1=on par) |

**Score = (Pain × Alignment × Gap) / (Cost × Risk)**

| Score Threshold | Priority |
|----------------|----------|
| ≥ 18 | P0 — Must Have (roadblockers) |
| ≥ 8 | P1 — Should Have (high impact) |
| ≥ 3 | P2 — Nice to Have (useful) |
| < 3 | P3 — Future Fuel (deferrable) |

---

## Current Backlog

### P1 — Should Have

#### 1. Undo/Rollback Command (Score: 13.3)
- **Signal**: Codex CLI users: "/undo" needs to come back (↑510). Claude Code users: destructive changes without review.
- **What to build**: `dvalincode chat` should support `/undo` — revert the last tool action. Keep a stack of tool results with reverse operations.
- **DvalinCode advantage**: Since we have typed tools with known schemas, we can compute reverse operations:

```
/edit_file "src/main.ts" old:"a()" new:"b()"  →  /undo  →  edit back old:"b()" new:"a()"
/write_file "config.ts" content:"..."         →  /undo  →  restore previous version or delete
/shell "rm -rf dist"                           →  /undo  →  warn: irreversible
```
- **Implementation**: `AgentLoop` gains an `UNDO` state. Track per-turn tool calls in a stack. Each tool declares `isUndoable()` and `reverse(input, result)`.
- **Files to modify**: `src/agent/types.ts` (TurnState.UNDO), `src/agent/loop.ts` (undo handler), `src/tools/types.ts` (reverse interface), `src/tools/writeFile.ts`, `src/tools/editFile.ts` (reverse implementations)

---

### P2 — Nice to Have

#### 2. Token Efficiency / Cost Awareness (Score: 6.4)
- **Signal**: "Burning tokens very fast" (↑558). Agent context bloat.
- **What to build**: Show token cost per turn. Implement smart context compaction. Add `--cost` flag that shows running total.
- **Already partially done**: The AgentLoop has a `COMPACT` state and `summarizeSession()`. Need to surface costs and make compaction smarter.

#### 3. Provider-Neutral + Local Model Support (Score: 6.0)
- **Signal**: Cross-source. Claude regression (↑3337/992), rate limits (↑2513), Qwen approaching Opus (↑2075).
- **What to build**: Already built (`ProviderAdapter`)! Just need to document how to add custom providers and add an Ollama/local model guide. Also add a `--provider` flag override.
- **Already done**: ProviderManager, env vars, OpenAI-compatible adapter. Quick win: write a provider docs guide.

#### 4. Session Lifecycle Management (Score: 6.0)
- **Signal**: Context management tools confusion (↑175), losing work, session fragmentation.
- **What to build**: `dvalincode sessions list`, `dvalincode sessions delete`, `dvalincode chat --resume` with interactive session picker. Show last N sessions on `dvalincode chat` startup.
- **Already partially done**: Sessions store exists (save/load/list/delete). Need CLI commands + better UX.

#### 5. Approval Gates / Guardrails (Score: 4.8 / 3.8)
- **Signal**: Vibe coding quality issues (↑7046), destructive changes without review (cross-source).
- **What to build**: Pre-commit review mode: agent makes changes in a draft branch, user approves per-file before apply. Also: `.dvalincodeignore` file for excluding sensitive paths.
- **Already partially done**: Permission system exists (read/write/execute). Need ignore-file and review mode.

#### 6. LSP Integration / Code Intelligence (Score: 4.5)
- **Signal**: Codex CLI #8745 (↑768).
- **What to build**: Auto-detect project LSP, pipe diagnostics to agent for context-aware code analysis.
- **Note**: High complexity. Could start with a `diagnose` tool that runs `tsc --noEmit` or similar.

#### 7. Sensitive File Exclusion (Score: 3.8)
- **Signal**: "A way to exclude sensitive files" (↑766).
- **What to build**: `.dvalincodeignore` file (like `.gitignore`) that the tool system respects globally. Agent cannot read/write ignored files.

#### 8. Large Context Support (Score: 3.3)
- **Signal**: 1M token context request (↑482).
- **What to build**: When sending to providers that support large context, pass max context size. ProviderAdapters should advertise `maxContextTokens`.

---

### P3 — Future Fuel

| Score | Requirement | Note |
|-------|-------------|------|
| 2.9 | Rate limit awareness | Informational (provider-side, not DvalinCode's problem to solve) |
| 2.2 | .gitignore-aware search | Already partially implemented (read tool skips node_modules) |
| 2.2 | Model comparison/benchmarks | Informational, out of scope for a coding agent |
| 2.2 | Local model (Ollama) support | ProviderAdapter already supports this — docs gap only |
| 2.2 | Context management UX | Session management (P2 above) covers most of this |
| 1.2 | Command discoverability | `dvalincode --help` already works, could be richer |
| 1.1 | Shell ENV management | Edge case, low demand |
| 0.2 | Desktop app | Irrelevant for CLI tool |

---
---
|
|### P2 — Nice to Have (New, 2026-05-21)
|
|#### 9. LSP Integration (Score: 6.7) ⬆️ Updated from 4.5
|- **Signal**: Codex CLI #8745 (↑774 — up from ↑768 last week). Growing demand for auto-detect + auto-install LSP.
|- **What to build**: Auto-detect project LSP, pipe diagnostics to agent for context-aware code analysis.
|- **Note**: Already listed as P2 #6 (Score: 4.5). Updated score reflects increased community demand.
|
|#### 10. Claude Code Exodus / Google-Play-Safe Positioning (Score: 6.7)
|- **Signal**: Claude Code removed from Pro plan (↑1704). Growing dissatisfaction — "I've had it with Claude" (↑987), "Something doesn't add up" (↑384).
|- **What to build**: Capitalize on Claude dissatisfaction. Emphasize DvalinCode's provider-neutrality, no-rate-limit model. Not a feature per se — a messaging/positioning opportunity.
|- **Why now**: Anthropic just made Claude Code Pro-only. Competitors are bleeding users. This is a strategic window.
|
|#### 11. Sensitive File Exclusion — Score Upgrade (Was P2 #7, score 3.8 → new score: 5.0)
|- **Signal**: Codex CLI #2847 (↑770 — up from ↑766 last week). Consistent demand.
|- **What to build**: `.dvalincodeignore` file (like `.gitignore`) that the tool system respects globally.
|- **Recommendation**: Merge with P2 #5 (Approval Gates) since both are about execution safety and share similar mechanisms.
|
|#### 12. Vibe Coding Guardrails Amplification (Score: 5.5)
|- **Signal**: "Inherited a vibe-coded repo" hit ↑7061. This is the #1 post on r/ClaudeCode this cycle. Vibe coding quality issues (↑7046) remain the top complaint.
|- **What to build**: Strengthen existing Approval Gates / Guardrails initiative (P2 #5). Add a `dvalincode review` command that analyzes generated code quality before committing. Post-vibe-code audit tooling.
|- **DvalinCode angle**: Position as "the agent that writes maintainable code" vs. the Wild West of vibe coding.
|
|#### 13. Provider-Neutral — Qwen/Ollama Integration Docs (Score: 5.5)
|- **Signal**: Hugging Face co-founder says Qwen 3.6 27B ≈ Opus in Claude Code (↑2069). "This new model is insane" (↑2005). Local model movement is accelerating.
|- **What to build**: Write the Ollama/local model integration guide. Add a `--provider` flag override. This is already mostly done — just a docs/CLI gap.
|- **Already done**: ProviderAdapter, ProviderManager, OpenAI-compatible adapter.
|
|### New Items (P3)
|
|#### My opinion on Opus 4.7 after heavy use since release (Score: 2.0)
|- **Source**: https://reddit.com/r/ClaudeCode/comments/1svzil1/my_opinion_
|- **Pain**: 2/5, **Align**: 3/5, **Cost**: 3/5, **Risk**: 3/5, **Gap**: 3/5
|- **Note**: Personal opinion, no actionable signal.
|
|#### Login shells override inherited PATH (Score: 1.5)
|- **Source**: https://github.com/openai/codex/issues/8922
|- **Pain**: 2/5, **Align**: 1/5, **Cost**: 2/5, **Risk**: 4/5, **Gap**: 2/5
|- **Note**: Codex-specific config issue. DvalinCode uses Hermes runtime with explicit tool env. Not relevant.
|
|#### WebSocket upgrade policy error (Score: 1.2)
|- **Source**: https://github.com/openai/codex/issues/13041
|- **Pain**: 1/5, **Align**: 1/5, **Cost**: 2/5, **Risk**: 4/5, **Gap**: 2/5
|- **Note**: Codex infrastructure bug. Not applicable to DvalinCode.
|
|#### High GPU usage from animation (Score: 0.5)
|- **Source**: https://github.com/openai/codex/issues/16857
|- **Pain**: 1/5, **Align**: 1/5, **Cost**: 3/5, **Risk**: 4/5, **Gap**: 1/5
|- **Note**: Codex terminal UI issue. DvalinCode is CLI-first, irrelevant.
|
|#### Codex desktop app for Linux (Score: 0.2)
|- **Source**: https://github.com/openai/codex/issues/11023
|- **Pain**: 2/5, **Align**: 1/5, **Cost**: 2/5, **Risk**: 4/5, **Gap**: 1/5
|- **Note**: Desktop app is philosophically incompatible with DvalinCode's CLI-first, lightweight approach.
|
|#### I let my interns vibe code from day one but with rules (Score: 2.5)
|- **Source**: https://reddit.com/r/ClaudeCode/comments/1sryeqw
|- **Pain**: 2/5, **Align**: 4/5, **Cost**: 3/5, **Risk**: 4/5, **Gap**: 3/5
|- **Note**: Interesting case study about structured vibe coding. Could inform guardrails feature. Informational.


## Update 2026-06-10 — Release Intelligence (opencode · Claude Code · OpenAI Codex)

> Source data: `data/release_intel_20260610.md` — opencode v1.16.0–v1.17.0 · Claude Code 2.1.157–2.1.170 · Codex rust-v0.134.0–v0.139.0.
> All three vendors converged on the same three investments this cycle. Development plans: `plans/02-subagent-tasks.md`, `plans/03-mcp-support.md`, `plans/04-execution-safety.md`.

### P1 — New Requirements

#### 14. Subagent & Background Tasks (Score: 13.3)
- **Pain**: 4/5 · **Align**: 4/5 · **Cost**: 2/5 · **Risk**: 3/5 · **Gap**: 5/5
- **Signal**: Claude Code dedicated the bulk of 2.1.157–2.1.170 to `claude agents` (dispatch/attach/reply, retire→wake, worktree isolation). opencode v1.16.2 added background subagents. Codex v0.137+ shipped multi-agent v2. Strongest cross-vendor theme of the cycle; DvalinCode has nothing.
- **What to build**: A `task` tool that spawns a scoped child `AgentRunner` (read-only tool set by default), then a background mode with a task manager, status polling, and WS progress events.
- **Plan**: `plans/02-subagent-tasks.md`

#### 15. MCP Client Support (Score: 12.5)
- **Pain**: 4/5 · **Align**: 5/5 · **Cost**: 2/5 · **Risk**: 4/5 · **Gap**: 5/5
- **Signal**: all three vendors hardened MCP this cycle — opencode v1.17.0 (abort signals, pagination, capability respect), Codex (readOnlyHint concurrency, OAuth, `oneOf`/`allOf` schema fidelity), Claude Code (managed policies, secrets redaction). MCP is now table stakes for an agentic CLI, and it multiplies our provider-neutral, open-ecosystem positioning.
- **What to build**: zero-dependency stdio JSON-RPC client; map server tools into `ToolRegistry` as `mcp__<server>__<tool>`; reuse the existing approval gates for non-read MCP tools.
- **Plan**: `plans/03-mcp-support.md`

#### 16. Execution Safety Hardening (Score: 11.1)
- **Pain**: 5/5 · **Align**: 5/5 · **Cost**: 3/5 · **Risk**: 3/5 · **Gap**: 4/5
- **Signal**: opencode v1.16.2 now refuses loose edit matches; Claude Code 2.1.160 prompts before writing shell-startup files and build-tool configs that grant code execution; Codex v0.136/v0.139 hardened command safety and sandbox escalation. Continues our #1 community signal (vibe-coding guardrails, ↑7061).
- **What to build**: unique-match `edit_file` (+ explicit `replaceAll` opt-in), `write_file` overwrite flag, approval-guarded sensitive paths (`.npmrc`, `.git/hooks/`, …), `bwrap` sandbox parity on Linux.
- **Plan**: `plans/04-execution-safety.md`

### Runner-up (tracked, not planned this cycle)
- **Session lifecycle v2** — history search, archive, context-overflow recovery (Codex v0.134/v0.136, opencode v1.17.0). Pain 3 · Align 5 · Cost 4 · Risk 4 · Gap 4 → Score 3.8 (P2). Foundation already exists (sessions store + UI restore); revisit next cycle.

### Housekeeping note
`FEATURE_GAP.md` (2026-05-22) is stale: P0-1 streaming, P0-2 approval flow, P0-3 interrupt/cancel, and P0-4 session restore have all shipped as of v0.3.0.

---

## Update 2026-06-11 — Gemini Competitive Analysis

> Source: Gemini review of DvalinCode positioning vs. Cline / Aider / Cursor / Claude Code.
> Two net-new items surfaced; three pain points confirmed existing direction. Plans: `plans/05-compact-command.md`, `plans/06-team-playbook.md`.

### Assessment: what Gemini confirmed (no new work needed)

| Pain point | DvalinCode answer | Status |
|---|---|---|
| 黑盒焦虑 / 权限失控 | 3-mode physical isolation (Chat=read-only, Cowork=plan-then-approve, Code=full-auto) | ✅ Shipped v0.3.0 |
| 环境依赖重 | Single ~25 MB zero-dep binary, `install.sh` one-liner | ✅ Shipped |
| LLM 厂商绑定 | `ProviderAdapter` treats DeepSeek / Ollama / OpenAI as first-class | ✅ Shipped |
| CLI vs. heavy GUI | CLI start → auto-launch Web UI with code highlight + diff view | ✅ Shipped v0.3.0 |
| 团队 AI 指令无法共享 | `AGENTS.md` committed to repo, shared with whole team | ✅ Shipped v0.3.0 |

### P2 — New Requirements (from Gemini)

#### 17. `/compact` — User-Triggered Context Compression (Score: 8.0) ⬆️ Upgrade from P2 #2

> Replaces / supersedes P2 #2 (Token Efficiency / Cost Awareness). AgentLoop already has a COMPACT state; this turns it into an explicit user command with a structured output format.

- **Pain**: 4/5 · **Align**: 5/5 · **Cost**: 4/5 · **Risk**: 5/5 · **Gap**: 4/5
- **Score**: (4×5×4) / (4×5) = **8.0** → P2 (was 6.4, upgrading based on local-model framing)
- **Signal**: Local and cheap model users (DeepSeek, Ollama/Qwen) hit context limits and start hallucinating far sooner than Claude/GPT-4 users. `/compact` is the mechanism that makes a 32k-context local model viable for a full coding session. Gemini specifically called out that no competitor surfaces this as a first-class user command with a structured output.
- **What to build**:
  1. `/compact` slash-command in the Web UI chat input
  2. Backend: call existing `summarizeSession()` → rewrite conversation to a structured summary:
     ```
     ## Goal
     <one-sentence statement of the session's objective>
     ## Completed
     - <list of tasks finished, with file paths>
     ## Key Decisions
     - <architectural choices, API design, non-obvious picks>
     ## Pending
     - <remaining work items>
     ```
  3. Replace the full message history with a single `system` message containing this summary + a `user` message with the pending list
  4. Show a "Context compressed: 12 400 → 800 tokens (−94%)" toast in the UI
- **Value prop**: Explicitly framed as "the feature that makes local and cheap models viable for long sessions."
- **Plan**: `plans/05-compact-command.md`

---

#### 18. Team AI Playbook — `dvalin.json` (Score: 4.0)

- **Pain**: 4/5 · **Align**: 5/5 · **Cost**: 4/5 · **Risk**: 5/5 · **Gap**: 4/5
- **Score**: (4×5×4) / (4×5) = **4.0** → P2
- **Signal**: Currently, the Routines panel (Run tests / Type check / Build / Git status / Lint) is stored in `localStorage`. When a new teammate clones the repo or you switch machines, all those AI quick-commands are gone. AGENTS.md shares the AI context, but not the runbook of automation commands. Gemini identified this as the next natural extension: commit a `dvalin.json` to the repo and ship everyone the same AI automation playbook.
- **What to build**:
  1. On startup, DvalinCode reads `<workspace>/.dvalin.json` (if present) and merges its `routines` list into the Routines panel
  2. In the Routines panel UI, add an **Export** button: writes current routines to `.dvalin.json` in the workspace root
  3. Schema (minimal):
     ```json
     {
       "version": 1,
       "routines": [
         { "label": "Run tests", "prompt": "Run the full test suite and report failures" },
         { "label": "Type check", "prompt": "Run tsc --noEmit and list all type errors" }
       ]
     }
     ```
  4. `.dvalin.json` committed to git → every `git clone` delivers the same AI playbook
- **DvalinCode differentiator**: No other tool makes "team AI automation commands" a first-class git artifact. AGENTS.md gives context; `dvalin.json` gives commands. Together they form a complete "AI onboarding file" for a project.
- **Plan**: `plans/06-team-playbook.md`

---

## Update 2026-06-12 — v0.5 Roadmap: Security Differentiation (user-directed)

> Source: `data/roadmap_v05_20260612.md` — a user-authored strategic brief, not a
> competitor-intel scrape. Plans: `plans/07-audit-trail.md`,
> `plans/08-policy-engine.md`, `plans/09-checkpoint-rollback.md`.
>
> **Positioning shift:** from *“small enough to audit”* (the code is auditable) to
> *“every agent action is auditable and policy-enforced.”* Security stops being a
> mode toggle and becomes the product's moat.

### ⚠️ Scoring caveat — this is a differentiation cycle, not a catch-up cycle

The standard formula `(Pain × Align × Gap) / (Cost × Risk)` measures *catch-up*:
**Gap = "how far behind are we vs Codex/Claude Code? (5 = way behind)"**. For
features where **we would be ahead of everyone**, Gap ≈ 1 by definition — which
drives the score toward zero. That is exactly backwards for a moat play: *nobody
is ahead of us* is the whole point.

So this cycle ranks by **differentiation value + career signal per hour** (the
roadmap's stated principle), and the formula scores below are recorded for
continuity only. **Do not let a future cycle see “1.25” and deprioritize #19** —
the low number reflects market lead, not low value. Strategic priority (the
roadmap's P0/P1) governs.

| # | Requirement | Pain | Align | Gap | Cost | Risk | Formula | Strategic |
|---|-------------|:----:|:-----:|:---:|:----:|:----:|:-------:|:---------:|
| 19 | Audit Trail + Run Report | 3 | 5 | 1 | 3 | 4 | 1.25 | **P0** |
| 20 | Enforced Policy Engine | 4 | 5 | 2 | 3 | 3 | 4.4 | **P0** |
| 21 | Checkpoint / Rollback | 4 | 5 | 3 | 4 | 4 | 3.75 | **P1** |

### P0 (strategic) — New Requirements

#### 19. Audit Trail — security-grade Agent Run Report
- **Differentiator**: tamper-evident, hash-chained JSONL audit log per run; the Run Report is its rendering layer. No local agent (Claude Code / Cursor / Aider) ships verifiable behavior logs.
- **Why now**: directly answers the recurring "black-box anxiety / destructive changes without review" signal (Gemini review; vibe-coding aftermath ↑7061) with structure rather than vibes — and it's the literal extension of the founding "small enough to audit" tagline.
- **What to build**: `~/.dvalincode/audit/run-*.jsonl` event stream (run_start/end, tool_call, file_read/write/delete with diff-stat + content hashes, shell_exec, approval, policy_violation), each event carrying `prev_hash` (SHA-256); a JSONL→Markdown Run Report (collapsible GUI card + export); CLI `report --last | <id> | verify`.
- **Enforcement-independent**: append-only side channel; a failed event write degrades to a warning and never aborts the run.
- **Plan**: `plans/07-audit-trail.md`

#### 20. Enforced Policy Engine — `dvalin.json` policies
- **Differentiator**: behavior constraints enforced at the `ToolRegistry` gating layer (registry.ts:40 `run()`), **before** execution and independent of prompt compliance — vs every competitor's prompt-level "please follow the rules."
- **Why now**: collapses two long-standing signals (sensitive-file exclusion ↑766/770, vibe-coding guardrails ↑7061) into one structural answer, and lands the AppSec story the THREAT-MODEL.md doc needs.
- **What to build**: new `policies` block in `dvalin.json` (deny_paths / readonly_paths / shell_allow+denylist / require_approval / max_files_per_run); a policy evaluator invoked in `ToolRegistry.run()`; applies in **all** modes incl. full-auto and Bypass (Bypass skips confirmation, not policy); blocks return a structured error to the agent + write a `policy_violation` audit event. Precedence: repo `dvalin.json` > user `~/.dvalincode/policy.json`, stricter wins. `.dvalincodeignore` documented as the read-dimension analog.
- **Companion**: `docs/THREAT-MODEL.md` mapped to OWASP LLM Top 10 / agentic risk — a portfolio artifact in its own right.
- **Plan**: `plans/08-policy-engine.md`

### P1 (strategic) — New Requirements

#### 21. Checkpoint / Rollback — run-level snapshot
- **What to build**: snapshot before each Cowork/Code run (`git stash create` or a shadow commit — no working-tree pollution); post-run GUI choice **Rollback / Keep / Commit**; CLI `checkpoint list` + `rollback <run-id>`; rollback itself logged to the audit trail. Builds on the existing op-level undo stack (`sharedUndoStack` / `runner.undoLast`).
- **Genuine gap here (Gap 3)**: Cursor checkpoints / Claude Code rewind exist; we only have operation-level `/undo`. Cheap (git does the work), so ship it — but it's parity, not the headline.
- **Plan**: `plans/09-checkpoint-rollback.md`

### Non-code deliverable (P1-2)
- **Design blog post**: *"Why prompt-level rules can't secure coding agents — building enforcement into the tool layer."* Covers #19/#20 design, hash-chain audit log, OWASP agentic mapping, and the *Bypass ≠ bypass policy* trade-off. Repo `docs/` + personal channels; quotable in job materials. Tracked, not a code requirement.

### P2 backlog (only with spare capacity)
| Requirement | Note | Why deferred |
|---|---|---|
| `dvalincode init` → starter AGENTS.md + `dvalin.json` w/ suggested policies | `init`/`scan` commands already exist (generate config) — extend to emit a playbook + policy starter | Table stakes (Claude `/init`, Cursor rules); completeness, not differentiation |
| PR Assistant (`dvalincode pr`) | PR description / risk / test checklist from audit log + diff | Commodity alone; **depends on #19** — only differentiated as "evidence-backed PR description" |
| Built-in Routines templates | 5–8 quality routines (Explain repo / Find bugs / Add tests / Review diff / Quality gate) | UX win, not a moat — templates only, no marketplace |

### Explicit non-goals (reaffirmed)
VS Code extension · plugin system · new model providers · multi-agent collaboration · cloud autonomous agent · routines marketplace. Each conflicts with the local-first / lightweight / safe-by-default identity or is over-architecture at current scale.

### Milestones
```
v0.5.0  #19 Audit log + Run Report (incl. verify)
v0.5.x  #20 Policy Engine + THREAT-MODEL.md
v0.6.0  #21 Checkpoint/Rollback + blog post
later   P2 as capacity allows (init → routines templates → PR assistant)
```

---

## Source Log

| Date | Source | Key Signal | Priority |
|------|--------|------------|----------|
| 2026-05-20 | GitHub CodexCLI #9203 | /undo restore request (↑510) | P1 |
| 2026-05-20 | GitHub CodexCLI #8745 | LSP integration (↑768) | P2 |
| 2026-05-20 | GitHub CodexCLI #2847 | Sensitive file exclusion (↑766) | P2 |
| 2026-05-20 | GitHub CodexCLI #14593 | Token burn rate (↑558) | P2 |
| 2026-05-20 | GitHub CodexCLI #2952 | .gitignore-aware search (↑180) | P3 |
| 2026-05-20 | Reddit r/ClaudeCode | Claude quality regression (↑3337) | P3 |
| 2026-05-20 | Reddit r/ClaudeCode | Rate limit complaints (↑2513) | P3 |
| 2026-05-20 | Reddit r/ClaudeCode | Vibe coding quality issues (↑7046) | P2 |
| 2026-05-20 | Reddit r/ClaudeCode | Context tool confusion (↑175) | P2 |
| 2026-05-20 | Reddit r/ClaudeCode | Provider lock-in / vendor independence | P2 |
| 2026-05-20 | HN Search | Agent coding tool discussions | P2 |

|| 2026-05-21 | Reddit r/ClaudeCode | LSP integration demand update (↑774, up from ↑768) | P2 |
|| 2026-05-21 | Reddit r/ClaudeCode | Claude Code removed from Pro plan (↑1704) — positioning opportunity | P2 |
|| 2026-05-21 | GitHub CodexCLI #2847 | Sensitive file exclusion update (↑770, up from ↑766) | P2 |
|| 2026-05-21 | Reddit r/ClaudeCode | Vibe coding aftermath horror post (↑7061) — guardrails signal | P2 |
|| 2026-05-21 | Reddit r/ClaudeCode | Qwen 3.6 ≈ Opus quality (↑2069) — local model docs priority | P2 |
|| 2026-05-21 | Reddit r/ClaudeCode | "This new model is insane" (↑2005) — local model trend | P3 |
|| 2026-05-21 | Reddit r/ClaudeCode | "I've had it with Claude" (↑987) — vendor lock-in anxiety | P3 |
|| 2026-05-21 | Reddit r/ClaudeCode | Sr Engineer wrote zero code for months (↑1588) | P3 |
|| 2026-05-21 | Reddit r/ClaudeCode | "Something doesn't add up" (↑384) — Claude trust erosion | P3 |
|| 2026-05-21 | Reddit r/ClaudeCode | Anthropic postmortem: Claude quality regression (↑3340) | P3 |
|| 2026-05-21 | Reddit r/ClaudeCode | Structured vibe coding case study (↑167) | P3 |
|| 2026-05-21 | Reddit r/ClaudeCode | Opus 4.7 opinion (↑116) — no actionable signal | P3 |
|| 2026-05-21 | GitHub CodexCLI #8922 | Login shell PATH override (↑230) — not DvalinCode-relevant | P3 |
|| 2026-05-21 | GitHub CodexCLI #13041 | WebSocket policy error (↑282) — Codex infra bug | P3 |
|| 2026-05-21 | GitHub CodexCLI #16857 | GPU animation usage (↑182) — not DvalinCode-relevant | P3 |
|| 2026-05-21 | GitHub CodexCLI #11023 | Desktop app for Linux (↑674) — incompatible philosophy | P3 |

| 2026-06-10 | opencode v1.16.0–v1.17.0 releases | Background subagents · MCP hardening · loose-edit-match refusal | P1 |
| 2026-06-10 | Claude Code 2.1.157–2.1.170 changelog | `claude agents` background sessions · guarded config writes · fallback models | P1 |
| 2026-06-10 | Codex rust-v0.134.0–v0.139.0 releases | Multi-agent v2 · session search/archive · sandbox escalation + permission profiles | P1 |
| 2026-06-11 | Gemini competitive review | `/compact` critical for local/cheap models; `dvalin.json` team playbook differentiator | P2 |
| 2026-06-12 | User strategic brief (v0.5 roadmap) | Audit trail + enforced policy engine as the security moat; differentiation > catch-up | P0 (strategic) |

## Shipped

| Date | Feature | Requirement |
|------|---------|-------------|
| 2026-05-20 | ProviderAdapter + OpenAI-compatible provider | Provider neutrality (P2-3) |
| 2026-05-20 | Session persistence + summary memory | Session management (P2-4) |
| 2026-05-20 | Permission system (read/write/execute) | Execution safety (P2-5) |
| 2026-06-03 | Streaming · interrupt/cancel · 3-mode approval flow + dialog UI · session restore in web UI · AGENTS.md memory · token usage display (v0.3.0) | FEATURE_GAP P0-1…P0-4, P1-1, P1-2 |
| 2026-06-03 | Undo stack · `git_status` tool · ignore-file · macOS sandbox-exec shell wrapper (v0.2.0–v0.3.0) | Undo (P1-1) · Git awareness · sensitive-file exclusion (P2-7) |
