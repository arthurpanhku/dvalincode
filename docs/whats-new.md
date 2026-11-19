# What's new

**English** · [中文](zh/whats-new.md)

Highlights of each release, newest first. Every change in every version is on
the [releases page](https://github.com/arthurpanhku/dvalincode/releases).

## ⭐ What's New in v0.24.0 — web access, more governed tools, a leaner GUI

- **The GUI server requires an access token** — `dvalincode serve` now refuses
  `/api` and `/ws` without the token it mints at each start, and the desktop
  app's embedded server does too from its next build. The printed launch link
  carries the token once, and the page trades it for an HttpOnly cookie; scripts
  send `Authorization: Bearer`. `DVALINCODE_SERVER_TOKEN` keeps one token across
  restarts. A link without it opens an unlock screen.
- **A leaner GUI** — the web GUI (and the desktop app from its next build) has
  one sidebar for every workspace: New chat (⌘N), the Chat / Code / Dvalin
  switch (Home is now Chat), recent conversations grouped by project, and
  Settings at the bottom. Ask and Collaborate move into the composer's mode
  menu. Controls that did nothing, like the intensity picker and the sidebar
  prompt templates, are gone. Enter no longer sends a message while an input
  method is still composing, the connection comes back after sleep, and the
  light theme renders code legibly.
- **The agent can search and read the web** — `web_search` uses Tavily, Brave
  Search or your own SearXNG endpoint. `web_fetch` reads a public page as text,
  asks once per site per turn, and refuses private, loopback and metadata
  addresses. Both follow the policy's `network` level and are audited by origin.
- **More governed tools** — read-only Git history (`git_log`, `git_show`,
  `git_blame`), regex search, ranged reads, batched `edit_file`, multi-file
  `apply_patch`, an `update_plan` checklist, structured `ask_user` questions,
  and image attachments in the GUI. Each passes the same policy and approval
  checks as every other tool.
- **Secrets stay out of the model** — tool output is filtered for recognizable
  credential formats before it is sent, and `write_file`, `edit_file` and
  `apply_patch` refuse to write the redaction placeholder back over a real key.
- **Budgets and rollback** — a policy can cap model spend with `maxCostUsd`.
  `dvalincode run --checkpoint` snapshots covered files, so
  `dvalincode rollback <run-id>` can restore them after a headless run, whether
  it succeeded or failed.
- **Stricter headless runs** — one policy snapshot holds for the whole run,
  unattended runs refuse a policy they cannot apply, and resumes stay in their
  original workspace. `stream-json` consumers should read
  `tool_call.inputSummary` instead of `tool_call.input`.
- **Release inventories** — every release now ships CycloneDX SBOMs for the CLI
  and the web bundle.

---

## ⭐ What's New in v0.23.0 — connect Dvalin to the agents you already use

- **`dvalin agents` finds the coding agents on this machine** — Claude Code,
  Codex, Cursor, VS Code, Gemini CLI and OpenCode, and where Dvalin is already
  connected to each. It only looks: a command on `PATH`, the folder the agent
  creates, or its macOS app. Nothing is run or written.
- **`dvalin agents connect` wires Dvalin in** — it plans the MCP entry for every
  agent that lacks one and writes only with `--yes`, through the same writers as
  `mcp-install`. That command now also covers Codex (through `codex mcp add`),
  Gemini CLI and OpenCode. [Editors and MCP →](../integrations/mcp/)
- **CC Switch support** — `dvalin agents connect cc-switch` hands Dvalin to
  CC Switch through its own import link, and CC Switch syncs it into every agent
  it manages. `provider set cc-switch` now points at CC Switch's local routing,
  `127.0.0.1:15721`. It used to point at port 3456, which belongs to
  claude-code-router.
- **Import Codex Security scans** — `dvalin import` reads a sealed Codex
  Security scan directory, checking its manifest, hashes and coverage, or a
  SARIF handoff, into remediation cases. A portable Codex security skill and a
  repository-local plugin marketplace ship alongside.
  [Codex Security interop →](../integrations/codex-security/)
- **MCP clients learn the workflow when they connect** — at initialization the
  server tells an agent to scan uncommitted changes, check coverage before
  trusting zero findings, then inspect a finding and ask for independent
  verification.
- **A failed turn keeps its work** — a turn that fails part-way now saves what it
  finished, so its session can resume, and the audit log records its iterations
  and tokens.

---

## ⭐ What's New in v0.14.0 — Dvalin security engineering

- **Home unifies Chat and Cowork** — the GUI now has a single Home workspace
  with read-only Ask and approval-gated Collaborate intents, while keeping the
  same project and conversation context.
- **Code is focused again** — the old Security and Routines panels have been
  removed from Code so its sidebar is dedicated to projects and autonomous
  implementation.
- **Dvalin is a first-class workspace** — orchestrate the built-in scanner plus
  installed Semgrep CE, Trivy, and OSV-Scanner; import SARIF; score and triage
  findings; persist remediation cases; and create isolated repair worktrees.
- **One flow from evidence to draft PR** — selected findings can launch an
  evidence-backed Agent fix, run focused tests/typecheck/build and a fresh scan,
  review the diff, and explicitly publish a draft PR without automatic merge.
- **Agent loops converge sooner and cost less** — investigation-before-edit and
  stall detection reduce repeated failed actions, general tool output is
  bounded, prompts remain append-only for cache reuse, and provider usage now
  accounts for cache hits/misses.
- **Provider and evaluation upgrades** — native Anthropic prompt caching and
  cache accounting are supported, and the SWE-bench Docker harness reports
  official scores, policy violations, stalls, and token/cache metrics.

---

## ⭐ What's New in v0.12.4 — finish the task before stopping

- **Process narration no longer ends a task** — responses such as “let me
  verify the file” are recognized as pending work, and the agent immediately
  continues with the promised action instead of treating them as a final answer.
- **Truncated responses automatically recover** — provider finish reasons are
  preserved, so output cut off by a token limit triggers another model step.
- **Normal coding turns get room to finish** — the per-turn action limit is now
  an emergency 100-action guard rather than a routine 15-action stopping point;
  stricter organization policy limits still take precedence.
- **Completion is explicit** — Code mode is instructed to return a tool-free
  answer only after the requested work and focused validation are complete.

---

## ⭐ What's New in v0.12.3 — resilient long-running Code mode

- **Long coding turns keep going** — Code mode now compacts context during an
  active tool loop, accounts for the full provider request when estimating
  tokens, and raises the default iteration checkpoint from 10 to 40.
- **Interruptions are resumable** — completed tool state is persisted when a
  turn is interrupted or its connection closes, so a follow-up `continue`
  resumes from the actual workspace progress.
- **Visible, quieter agent activity** — running sessions show a sidebar loading
  state, each response reports elapsed work time, and its Action timeline is
  available on click while raw Tool Calls stay collapsed by default.
- **GitHub workflows from Code mode** — network-aware `git` and GitHub CLI
  (`gh`) operations now support pull, push, PR creation, and Actions/repository
  commands through the governed shell approval path.
- **Safer releases** — package and CLI versions are synchronized, and
  `prepublishOnly` runs the build, typecheck, and test suite before publishing.
- **Simple tasks stay simple** — the Action budget is enforced across the whole
  turn instead of resetting on every model iteration, and Code mode is prompted
  to take the shortest direct path and stop when focused validation passes.

---

## ⭐ What's New in v0.12.2 — 🖥️ Desktop app milestone: it just works

- **🖥️ The native desktop app now works out of the box on macOS** — `DvalinCode.app`
  opens a real dock window (WKWebView, no Electron) over the embedded engine.
  Two threading bugs that shipped in every earlier desktop build are fixed:
  the blocking webview loop no longer starves the embedded server (blank
  window), and the webview runs on the main thread as macOS requires (no
  window at all) — the server now lives in a child process of the same binary.
- **📦 The one-line installer installs the app** — on macOS,
  `curl … install.sh | bash` now also puts `DvalinCode.app` (with the
  DvalinCode icon) into `/Applications`, so the desktop window launches
  straight from Launchpad after a CLI install. Opt out with
  `DVALINCODE_NO_APP=1`; pin with `DVALINCODE_GUI_VERSION`.
- **✅ Desktop is no longer "experimental" on macOS** — the window and the
  embedded server are verified working; Windows and Linux desktop builds are
  cross-compiled and remain a preview.

<details>
<summary>v0.9.0 — 🛡️ Secure remediation · Skills · CodeQL hardening</summary>

- **🛡️ Secure remediation workflow** — run a built-in local scan or import SARIF
  from CodeQL, GitHub Code Scanning, Semgrep, and compatible scanners; findings
  become local remediation cases with source context, verification guidance, and
  isolated worktree repair tasks.
- **📚 Skills** — upload, download, inspect, and reuse local skill bundles.
  DvalinCode now ships built-in secure-code-scan and secure-code-remediation
  skills, plus agent tools for listing skills, reading instructions, scanning,
  listing remediation cases, and preparing remediation worktrees.
- **🔐 CodeQL path hardening** — user-controlled workspace, remediation, and
  skill paths now go through explicit root-containment checks, with regression
  tests covering traversal-safe resolution and skill import boundaries.
- **🎨 App icons** — dark and light theme application icons now ship with the web
  bundle and desktop build inputs.

</details>

<details>
<summary>v0.8.0 — 🔒 Governance: controllable · transparent · auditable</summary>

- **🔒 Org policy** — a `dvalin.policy.json` lets a *company*, not the developer, bound the agent: which modes, shell commands, file paths, tools, and models are allowed. Two layers (machine `~/.dvalincode/policy.json` + repo) resolve by **narrowing** — a repo policy can only ever make the machine policy stricter, never widen it. With no policy file, behavior is identical to before. Enforced at a single chokepoint; every denial is an inline `⛔ Blocked by policy` plus a `policy_violation` audit event. [Policy reference →](./POLICY-REFERENCE.md)
- **🔎 `dvalincode trust`** — prints this install's live security posture in one command — active policy + source hashes, audit status, runtime, dependencies — so a reviewer can verify what the agent may and may not do directly, instead of taking claims on trust. `--json` for tooling.
- **`dvalincode policy check`** — validates `dvalin.policy.json` against the schema, prints the resolved policy + canonical hash (after narrowing with the machine layer), and exits non-zero on failure — for CI and policy authoring. [Policy reference →](./POLICY-REFERENCE.md)
- **🧾 Policy-aware audit** — every run records the hash of the governing policy (and which files contributed) in `run_start`, so the tamper-evident log proves *which* rules were in force.
- **📐 Approvability plan** — the through-line is documented in [docs/APPROVABILITY-PLAN.md](./APPROVABILITY-PLAN.md): make DvalinCode trivially approvable by any company — controllable, transparent, auditable.

</details>

<details>
<summary>v0.7.0 — 🧪 Desktop app (beta)</summary>

- **🧠 Portable memory & full data export/import** — the upgraded local memory mechanism, plus every session, config, profile, and audit log, can now be bundled into a single file and restored on another machine. Migrate your whole setup in one step: `dvalincode export` / `dvalincode import`, or the **Export / Import** buttons in the GUI Settings panel.
- **📝 Download any AI interaction as Markdown** — every conversation can be saved as a clean Markdown transcript (user turns, assistant replies, tool calls + results, decisions — all inline). Use the download icon on any session in the sidebar, `dvalincode session md <id>`, or `GET /api/sessions/:id/markdown`.
- **🖥️ Native desktop app** — a real application window (not a browser tab) over the same engine: `DvalinCode.app` on macOS, plus Windows/Linux builds. Built with [webview-bun](https://github.com/tr1ckydev/webview-bun) using the OS-native webview (WKWebView / WebView2 / WebKitGTK) — no Electron, stays a small self-contained binary.
- **🧩 A third frontend, one core** — the desktop app, terminal UI, and web GUI all drive the same shared turn-runner. The current `dvalincode` binary is now positioned purely as the **CLI** (terminal + `serve`).
- **Status:** the desktop binaries are **experimental / unverified** — grab them from the latest **pre-release** and please report how the window behaves on your OS.

</details>

<details>
<summary>v0.6.0 — terminal agent · <code>serve</code> · shared turn-runner</summary>

- **🖥️ Terminal agent** — run `dvalincode` bare for an interactive terminal coding agent, Claude-Code-style: streaming responses, inline `[y/N]` write approvals with red/green diffs, `/mode` · `/clear` · `/git` · `/plan` · `/compact` · `/undo` · `/help`, Ctrl-C to interrupt, and a guided first-run provider setup. Defaults to read-only **Chat**, switchable live.
- **🌐 `dvalincode serve`** — the web GUI now lives behind a command, so the *same* binary deploys headless on a server: `dvalincode serve --host 0.0.0.0 --no-open`.
- **🧩 One engine, two frontends** — the terminal UI and web GUI both drive a shared, transport-agnostic turn-runner (`src/agent/session.ts`), keeping them at feature parity.

</details>

<details>
<summary>v0.5.0 — security-grade audit trail · Run Report · theme switcher</summary>

- **🛡️ Security-grade audit trail** — every Cowork/Code run writes a tamper-evident, hash-chained JSONL log to `~/.dvalincode/audit/` (`run_start`, every `tool_call` / `file_*` / `shell_exec` / `approval`, `run_end`). The hash chain makes any after-the-fact edit detectable. No local coding agent ships verifiable behavior logs. [Format + threat model →](./AUDIT-TRAIL.md)
- **📋 Run Report + `dvalincode report` CLI** — a Markdown summary of each run (files read/changed, commands, decisions, test result), rendered as a collapsible card in the GUI and from the CLI:
  ```sh
  dvalincode report --last           # render the most recent run
  dvalincode report <run-id> --format json
  dvalincode report verify <run-id>  # ✓ chain intact / ✗ broken at seq N
  ```
- **🎨 Theme switcher** — choose **dark / light / system** in Settings. `system` follows your OS live; the choice persists across sessions.

</details>

<details>
<summary>v0.4.0 — <code>/compact</code> · <code>dvalin.json</code> team playbook · self-contained binaries</summary>

- **`/compact`** — LLM-based context compaction: replaces conversation history with a structured five-section summary (Goal / Completed / Decisions / Current State / Pending). A divider in the chat thread shows the token reduction (e.g. `8,412 → 1,203 tokens −85%`).
- **`dvalin.json` team playbook** — commit a shared set of automation prompts to your repo. The sidebar loads them automatically and lets teammates run the same one-click routines without any manual setup. Export button converts your personal routines to `dvalin.json` in one click.
- **Self-contained binaries** — single ~25 MB executable per platform; no Node, no Python, no Docker. Auto-opens your browser on launch. Built with `bun --compile` so the web UI is bundled alongside the server binary.

</details>

<details>
<summary>v0.3.0 — Mode-aware sidebar · one-line installer · multi-profile LLM config</summary>

- **Mode-aware sidebar** — Chat shows quick-prompt **Templates**, Cowork shows a **Projects** folder tree, Code shows custom **Routines** (one-click commands like "Run tests" / "Git status" / "Type check"). Add your own routines from the sidebar — they persist in `localStorage`.
- **One-line installer** — `curl … | bash` auto-detects your OS + arch, drops the binary into `~/.dvalincode/`, and patches your `PATH`. No package manager dependencies.
- **Multi-profile LLM config** — save named (provider, model, API key) sets and switch in one click from the sidebar; live per-session cost counter in the topbar so you can compare providers on the fly.

</details>
