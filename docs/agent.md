# The built-in agent

**English** · [中文](zh/agent.md)

DvalinCode ships its own coding agent: the interactive terminal agent
(`dvalincode`), the web GUI (`dvalincode serve`) and the
[desktop app](gui.md). In Dvalin's verification workflow it is one fixer among
several: Codex, Claude Code or a person can write the repair instead, and like
every fixer it never decides whether the repair worked. This page covers what
the [CLI](cli.md) and the desktop app share: modes, tools, providers, the
architecture and the FAQ.

## Modes and capabilities

<table>
<tr><td><b>🏠 Home</b></td><td>One place for read-only <b>Ask</b> and approval-gated <b>Collaborate</b> workflows. Switch intent without leaving the project or conversation.</td></tr>
<tr><td><b>⚡ Code</b></td><td>Focused autonomous coding with full tool access and Ask / Plan / Auto / Bypass permission levels. Security and browser routines no longer compete with the core coding workflow.</td></tr>
<tr><td><b>🛡️ Dvalin</b></td><td>Dedicated white-box security engineering: orchestrate the built-in scanner plus installed Semgrep CE, Trivy, and OSV-Scanner; triage findings; create isolated fixes; run tests and re-scan; then explicitly publish a reviewable draft PR. <a href="DVALIN.md">Dvalin guide →</a></td></tr>
<tr><td><b>🛡️ Secure remediation</b></td><td>Run a multi-engine scan or import SARIF from CodeQL, GitHub Code Scanning, Semgrep, or compatible scanners, then create an isolated remediation worktree and turn findings into focused repair tasks with source context, verification evidence, and PR-ready reporting. <a href="SECURE-REMEDIATION.md">Workflow →</a></td></tr>
<tr><td><b>📚 Skills</b></td><td>Upload, download, and inspect local skill bundles. DvalinCode ships built-in secure-code-scan and secure-code-remediation skills, plus agent tools for listing skills, reading skill instructions, scanning, listing cases, and preparing remediation worktrees. <a href="SKILLS.md">Format →</a></td></tr>
<tr><td><b>🖥️ First-class GUI</b></td><td>Modern web UI with code highlighting, file <code>@</code>-references, <code>/</code> slash commands, Git branch indicator, live token + cost counter, multi-profile LLM config, and a dark / light / system theme switcher.</td></tr>
<tr><td><b>🖥️ Terminal or web — one binary</b></td><td>Run it bare for an interactive <b>terminal agent</b> with streaming output, inline approvals, and red/green diffs, or <code>dvalincode serve</code> to host the <b>web GUI</b> for browser/remote use. Both frontends drive the same agent core.</td></tr>
<tr><td><b>🖥️ Native desktop app</b></td><td><code>DvalinCode.app</code> — a real dock application (OS-native webview, no Electron) over the same engine. On macOS the one-line installer with <code>--gui</code> puts it in <code>/Applications</code>; launch it straight from Launchpad. On Windows a per-user setup executable installs it with a Start menu entry and an uninstall entry — no administrator, no UAC prompt, and no browser tab.</td></tr>
<tr><td><b>🪶 Zero-dependency binary</b></td><td>Single ~25MB executable per platform. No Node, no Python, no Docker.</td></tr>
<tr><td><b>🔐 Local-first</b></td><td>Sessions, config, profiles, and audit logs live in <code>~/.dvalincode/</code>. <code>.dvalincodeignore</code> blocks the agent from reading sensitive files. <code>AGENTS.md</code> in your repo becomes persistent project instructions.</td></tr>
<tr><td><b>💾 Portable & exportable</b></td><td>Export <b>all</b> local data (memory, sessions, config, audit) to one file and import it on another machine — your setup moves with you. Any conversation downloads as a clean <b>Markdown</b> transcript.</td></tr>
</table>

## Features

| Category | Feature | Notes |
|---|---|---|
| **Modes** | Home / Code / Dvalin | Home contains read-only Ask and approval-gated Collaborate; Code is focused autonomous development; Dvalin is the scan-to-fix security workspace |
| **Code permissions** | Ask Permissions / Plan Mode / Auto Mode / Bypass permissions | Verified behavior: Ask requests approval before writes/commands, Plan is read-only and does not write files, Auto runs operations automatically, Bypass runs without confirmation prompts |
| **Workspaces** | Open folder / Import Git / Add worktree | Cowork and Code can switch to a local folder, clone a Git project, or create a Git worktree from the UI |
| **Governance** | OpenSSF Scorecard / ISO 42001 AIMS alignment | Scorecard, CodeQL, Dependabot, pinned Actions, AI impact assessment, risk register, and review cadence are documented under `docs/security/` and `docs/governance/` |
| **Secure remediation** | Built-in + Semgrep CE + Trivy + OSV-Scanner / SARIF / cases / worktrees / tests / draft PR | Dvalin detects installed engines, normalizes SARIF, scores risk, persists cases, drives evidence-backed fixes, verifies changes, and publishes only after an explicit user action |
| **Agent integrations** | `dvalin agents` / MCP server | Finds Claude Code, Codex, Cursor, VS Code, Gemini CLI and OpenCode on this machine and wires Dvalin's MCP server into each, writing only with `--yes`; or hands it to CC Switch. [Editors and MCP →](../integrations/mcp/) |
| **Skills** | Upload / download / built-in security skills | Skills live under `~/.dvalincode/skills`; built-ins guide security scanning and remediation with dedicated agent tools. [Format →](SKILLS.md) |
| **Composer** | `@` file references | Type `@` for a fuzzy file search; selected files get inlined into the prompt |
| | `/` slash commands | `/clear` `/compact` `/git` `/plan` `/undo` `/help` |
| | Multiline + interrupt | <kbd>Shift</kbd>+<kbd>Enter</kbd> for newline, stop button to abort mid-stream |
| **Tool UI** | Inline diffs | `edit_file` and `write_file` results render as red/green unified diff, default folded |
| | Approval dialog with diff | Cowork mode shows the diff *before* the change is applied |
| | Live tool counter + token + cost | Topbar shows session totals in real time |
| **Agent** | LLM-based context compaction | `/compact` summarises into Goal / Completed / Decisions / Pending |
| | Persistent undo stack | `/undo [N]` reverses the last N tool calls |
| | Run Report | Markdown summary per run (files, commands, decisions, test result) — GUI card + `dvalincode report` |
| | Git awareness | Branch name in topbar; git context auto-injected into prompt; read-only `git_status`, `git_diff`, `git_log`, `git_show` and `git_blame` tools, also in Ask and Plan |
| | Code search and edits | `search_text` takes regular expressions, shows context lines, and skips `.gitignore`d paths; `edit_file` makes several edits or a replace-all in one call; `read_file` reads line ranges of files over 256 KB |
| | Task checklist | `update_plan` keeps a step checklist that the desktop app shows as a card; in Code mode the agent is sent back if it stops with steps still open |
| | `AGENTS.md` project memory | Per-repo persistent instructions, auto-loaded each turn |
| | Web search + fetch | `web_search` is free by default: it asks Exa's free tier, which needs no key, and your queries go to Exa. If that search fails, for example at Exa's free rate limit, it falls back automatically to a Tavily, Brave Search or Exa API key: the one saved in Settings → LLM Providers → Web search, then `TAVILY_API_KEY`, `BRAVE_API_KEY`, `EXA_API_KEY`. Your own SearXNG endpoint (`DVALINCODE_SEARXNG_URL`) takes Exa's place. Turn the free step off in Settings, or with `"freeWebSearch": false` in `~/.dvalincode/config.json`, which the CLI reads too. `web_fetch` needs no key and reads public pages as text, asking once per site per turn. Both obey the policy `network` level and are audited by origin only |
| **Security** | Tamper-evident audit trail | Hash-chained JSONL per run in `~/.dvalincode/audit/`; `dvalincode report verify` detects edits |
| | macOS shell sandbox | `sandbox-exec` denies network; allows writes only inside cwd + `/tmp` |
| | `.dvalincodeignore` | gitignore-style exclusion; blocks `read_file` / `list_files` / `search_text` |
| | Per-action approval | Approve/deny each write / delete / shell call in Cowork mode |
| **Appearance** | Theme switcher | Dark / light / system, persisted; `system` follows the OS live |
| **Providers** | OpenAI-compatible endpoints | See [Providers](#providers) |
| | Multi-profile config | Save and switch between named (provider, model, API key) sets |
| **Sessions** | Auto-save + restore | All sessions persisted to `~/.dvalincode/sessions/` as JSON |
| | LLM summary memory | Cross-session summary keeps the agent oriented after restart |
| **Memory** | Local user/project memory | Searchable facts, preferences, and decisions in `~/.dvalincode/memory/`; import from Claude/Hermes/Markdown |
| **Data portability** | Export / import all data | One bundle of memory + sessions + config + audit — `dvalincode export` / `import`, or GUI Settings → Export / Import |
| | Markdown transcript | Download any conversation as Markdown — sidebar download icon, `dvalincode session md <id>`, or `/api/sessions/:id/markdown` |

## Slash commands

| Command | Description |
|---|---|
| `/clear` | Clear the current conversation (client-side, starts a fresh session) |
| `/compact` | LLM-based context compaction — replaces history with a structured summary |
| `/undo [N]` | Reverse the last N tool calls (default 1) |
| `/git` | Run `git_status` and show branch, recent commits, changed files |
| `/plan <task>` | Ask the agent to plan the task step-by-step *without* executing |
| `/help` | Show all available slash commands |

## Providers

The agent talks to any OpenAI-compatible endpoint, local models included, and
to Anthropic through a native adapter.

- The terminal's first-run setup offers DeepSeek, OpenAI, Anthropic, Groq,
  OpenRouter and Ollama.
- The GUI's **LLM Configuration** also lists Google, Claude via OpenRouter,
  xAI, Mistral, Together, Fireworks, Perplexity, Qwen, Moonshot and Zhipu, plus
  **Custom** for any OpenAI-compatible base URL.
- **Ollama** runs on your machine: no API key, no internet, no per-token cost.
  Choose an open-weight model there if the repair step must also stay fully
  local and open; hosted model licensing depends on the provider.
- **CC Switch**: `provider set cc-switch` sends requests through CC Switch's
  local routing (`127.0.0.1:15721`) to whichever provider its Codex app uses;
  CC Switch holds the key.

Save named profiles and switch between them in **LLM Configuration**; the
topbar shows the session's cost live.

## Architecture

```
┌───────────────────────────┐   ┌─────────────────────────┐
│  Terminal UI (readline)   │   │  Browser GUI (React/Vite)│
│  streaming · approvals    │   │  ChatThread · DiffViewer │
└─────────────┬─────────────┘   └────────────┬────────────┘
              │ in-process          HTTP / WebSocket
              │                ┌───────────────▼─────────────┐
              │                │  Express + ws server         │
              │                │  /api/* · `dvalincode serve` │
              │                └───────────────┬─────────────┘
              └──────────────┬─────────────────┘
┌────────────────────────────▼────────────────────────────┐
│  runAgentTurn — shared turn-runner (src/agent/session)   │
│  provider · prompt (mode · git · AGENTS.md) · session    │
└────────────────────────────┬────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────┐
│                    Agent Engine                          │
│  AgentLoop (8-state machine) → AgentRunner              │
│  Streaming · Interrupt · Undo stack · LLM compaction    │
│  run_start / run_end → AuditSink (hash-chained JSONL)   │
└──────────────────────────┬──────────────────────────────┘
                           │ run()
┌──────────────────────────▼──────────────────────────────┐
│  ToolRegistry — Zod schemas + permission gating         │
│  + audit taps: tool_call · file_* · shell_exec          │
│  read_file · list_files · search_text · git_status ·    │
│  write_file · edit_file · delete_file · shell           │
│  web_search · web_fetch                                 │
│  git_log · git_show · git_blame · update_plan           │
└─────────────────────────────────────────────────────────┘
```

### Agent loop — 8 states

```
RESTORE → COMPACT → COMMAND → BUILD → RUN → SAVE → RESPOND → DONE
```

1. **RESTORE** — Load session from `~/.dvalincode/sessions/`
2. **COMPACT** — If context near the limit, compress history (LLM summary)
3. **COMMAND** — Handle built-in slash commands
4. **BUILD** — Assemble system prompt (mode prompt + project + git + AGENTS.md)
5. **RUN** — Delegate to `AgentRunner` for the LLM tool-calling loop
6. **SAVE** — Persist session
7. **RESPOND** — Generate cross-session summary memory
8. **DONE**

## FAQ

<details>
<summary><b>Does it send my code to a third party?</b></summary>
<br>
Only what the agent sends to the LLM you configured. Sessions, configs, and profiles all live on your machine in <code>~/.dvalincode/</code>. To exclude sensitive files from the agent's view, drop a <code>.dvalincodeignore</code> in your repo root (gitignore-style patterns).
</details>

<details>
<summary><b>Can I run this without an API key?</b></summary>
<br>
Yes — use Ollama. Pull a model (<code>ollama pull qwen2.5-coder</code>), then in the LLM Configuration modal pick the <b>Ollama</b> provider. No key, no internet, no per-token cost.
</details>

<details>
<summary><b>Why Home, Code, and Dvalin?</b></summary>
<br>
They represent different outcomes and safety defaults. <b>Home</b> groups read-only Ask and approval-gated Collaborate. <b>Code</b> is the focused software-development agent. <b>Dvalin</b> is a security pipeline with scanner evidence, remediation cases, isolated worktrees, verification, and explicit draft-PR publication. You can switch at any time while keeping project context.
</details>

<details>
<summary><b>Is the shell tool sandboxed?</b></summary>
<br>
On macOS, commands use <code>sandbox-exec</code>; on Linux, restrictive network policies use Bubblewrap when installed. Windows has no supported subprocess network sandbox yet, so restrictive policies fail closed instead of silently running unrestricted. The native command runner itself works on all three platforms.
</details>

<details>
<summary><b>Which operating-system shells are supported?</b></summary>
<br>
Linux and macOS commands run through <code>/bin/sh</code>; Windows commands run through the system <code>ComSpec</code> (<code>cmd.exe</code> by default). Full native command lines support pipes, redirects, and conditional operators. The split <code>command</code> + <code>args</code> form quotes executable paths and arguments for the host shell.
</details>

<details>
<summary><b>How do I see what the agent actually did — and is the log trustworthy?</b></summary>
<br>
Every run writes a JSONL audit log to <code>~/.dvalincode/audit/run-&lt;timestamp&gt;-&lt;id&gt;.jsonl</code>. Render it with <code>dvalincode report --last</code> (or see the collapsible Run Report card in the GUI). Each record is chained to the previous one with a SHA-256 hash, so any after-the-fact edit is detectable — <code>dvalincode report verify &lt;run-id&gt;</code> reports <code>✓ chain intact</code> or the exact position of a break. It's tamper-<b>evident</b>, not tamper-<b>proof</b>: a local attacker who can rewrite the whole file could recompute the chain. The value is forensic/accountability. See <a href="AUDIT-TRAIL.md">AUDIT-TRAIL.md</a> for the full threat model.
</details>

<details>
<summary><b>Will it overwrite my files without asking?</b></summary>
<br>
Depends on the mode. <b>Home → Ask</b> never writes. <b>Home → Collaborate</b> requires approval per file (with inline red/green diff before you click Allow). <b>Code</b> and <b>Dvalin</b> honor their selected permission level; use Auto only for trusted workspaces or isolated branches.
</details>

<details>
<summary><b>The macOS binary won't open — "unverified developer"</b></summary>
<br>
The binary is unsigned. Run this once to clear the quarantine flag:
<pre><code>xattr -dr com.apple.quarantine ~/.dvalincode</code></pre>
Or right-click the binary in Finder → Open → confirm once.
</details>

<details>
<summary><b>Does <code>AGENTS.md</code> get sent every turn?</b></summary>
<br>
Yes — DvalinCode reads <code>AGENTS.md</code> from the project root before each turn and injects it under <code>=== PROJECT INSTRUCTIONS ===</code> in the system prompt. Keep it focused — it counts toward your token budget.
</details>
