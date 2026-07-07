# Org policy reference (`dvalin.policy.json`)

DvalinCode bounds the agent with an **org policy** — a JSON file that IT or platform
teams author and that the tool enforces at a single chokepoint before any tool side
effect runs. The resolved policy is what `dvalincode trust` prints, what the audit log
hashes at `run_start`, and what the Approval Pack snapshots.

**Schema source:** [`src/core/policy.ts`](../src/core/policy.ts) (`orgPolicySchema`).

---

## Two layers, one effective policy

| Layer | Default path | Who writes it |
|---|---|---|
| **Machine** | `~/.dvalincode/policy.json` (override: `DVALINCODE_POLICY_FILE`) | IT / MDM |
| **Repo** | `<workspace>/dvalin.policy.json` | Team (committed) |

Both layers are read and merged by **narrowing (intersection)** — a repo policy can
only ever make the machine policy **stricter**, never wider. Order of discovery does
not matter for safety.

| Field kind | How layers combine |
|---|---|
| Allowlists (`modes`, `providers.allow`, `models.allow`, `commands.allow`, `paths.allow`, `mcp.allow`) | **Intersection** — only values permitted by *every* layer survive |
| Denylists (`commands.deny`, `paths.deny`, `tools.deny`) | **Union** — a deny in either layer blocks |
| `commands.defaultDeny` | **OR** — if any layer sets it, default-deny is on |
| `network` | **Most restrictive wins** — `off` < `endpoint-only` < `on` |
| `maxToolCalls` | **Minimum** — the smallest cap across layers applies |

Absent fields mean **unrestricted** for that dimension (equivalent to the permissive
default). A missing policy file is identical to no policy at all.

Malformed policy files are **not** treated as allow-all: they are skipped and surfaced
as `IGNORED (…)` in `dvalincode trust` so gatekeepers know a policy was intended but
did not apply. While authoring, validate before commit:

```sh
dvalincode policy check                  # validate ./dvalin.policy.json
dvalincode policy check path/to/file.json
dvalincode policy check --json           # machine-readable, CI-friendly (exit 1 on failure)
```

---

## Network levels

The `network` field controls outbound connections initiated by the agent (provider
requests, MCP, and subprocess egress under restricted postures).

| Level | Provider egress | Non-model egress (MCP, `curl` in shell, …) | Typical use |
|---|---|---|---|
| **`off`** | Blocked | Blocked | Air-gapped or fully offline review |
| **`endpoint-only`** | Allowed only to the configured model origin (redirects revalidated) | Blocked | Default enterprise posture — model calls OK, no arbitrary exfil |
| **`on`** | Unrestricted | Unrestricted (subject to OS subprocess sandbox defaults on macOS) | Developer machines, trusted networks |

Under `endpoint-only` and `off`, shell and `run_check` subprocesses run inside an OS
network sandbox when available (Seatbelt on macOS, Bubblewrap on Linux). See
[`docs/EGRESS-THREAT-MODEL.md`](EGRESS-THREAT-MODEL.md) for boundary details.

Verify the live posture anytime:

```sh
dvalincode trust          # human-readable resolved policy + enforcement
dvalincode trust --json   # machine-readable TrustReport
```

---

## Complete example (every field)

Copy-paste valid JSON. Each key is explained in the [field reference](#field-reference)
table below.

```json
{
  "modes": ["chat", "cowork", "code"],
  "providers": {
    "allow": ["deepseek", "openai", "ollama"]
  },
  "models": {
    "allow": ["deepseek-chat", "gpt-4o-mini", "qwen2.5-coder"]
  },
  "commands": {
    "allow": ["^npm\\b", "^node\\b", "^git\\b", "^pytest\\b"],
    "deny": ["^curl\\b", "^wget\\b", "^rm\\b", "^ssh\\b"],
    "defaultDeny": false
  },
  "paths": {
    "allow": ["src/**", "tests/**", "docs/**"],
    "deny": ["**/.env*", "secrets/**", "**/*.pem"]
  },
  "tools": {
    "deny": ["memory_import"]
  },
  "mcp": {
    "allow": ["github", "jira"]
  },
  "network": "endpoint-only",
  "maxToolCalls": 75
}
```

**Reading the example:**

- **`modes`** — agent may run in Chat, Cowork, or Code; omitting the key allows all three.
- **`providers.allow`** — only these provider profile ids (`deepseek`, `openai`, … in LLM config); omit = any provider.
- **`models.allow`** — only these model id strings; omit = any model.
- **`commands.allow`** — when set, the full shell command line must match **at least one** JavaScript regex; takes precedence over `defaultDeny`.
- **`commands.deny`** — always evaluated first; matching regex blocks regardless of allowlist.
- **`commands.defaultDeny`** — when `true` and no `allow` list is set, every shell command is blocked unless you add an allowlist.
- **`paths.allow` / `paths.deny`** — glob patterns (`**`, `*`, `?`); layered on top of `.dvalincodeignore` for read filtering.
- **`tools.deny`** — tool names from the registry (`shell`, `write_file`, `read_file`, …); deny wins before execution.
- **`mcp.allow`** — MCP server `id` values from `~/.dvalincode/config.json`; omit = any configured server; `[]` = none permitted.
- **`network`** — outbound posture (see [network levels](#network-levels)).
- **`maxToolCalls`** — hard cap on tool invocations per agent run; omit = unlimited. Resolved and reported by `trust`; enforced at run start when set.

---

## Field reference

| Field | Type | Default when absent | Semantics |
|---|---|---|---|
| `modes` | `"chat" \| "cowork" \| "code"[]` | all three modes | Subset of agent modes permitted. Cowork = plan-then-approve writes; Code = full-auto. |
| `providers.allow` | `string[]` | any provider | Allowlist of provider profile **ids** (e.g. `deepseek`, `openai`, `ollama`). User config cannot bypass a machine-level deny. |
| `models.allow` | `string[]` | any model | Allowlist of model id strings exactly as configured (e.g. `deepseek-chat`, `gpt-4o-mini`). |
| `commands.allow` | `string[]` | no allowlist gate | JavaScript regexes tested against the **full** shell command line. When present, only matching commands run. |
| `commands.deny` | `string[]` | `[]` | JavaScript regexes; evaluated **before** allowlist. Malformed patterns never match (fail-safe). |
| `commands.defaultDeny` | `boolean` | `false` | When `true` and `commands.allow` is unset, block all shell commands. Combine with `allow` for allowlist-only shells. |
| `paths.allow` | `string[]` | workspace + ignore rules | Glob allowlist; paths outside all patterns are blocked for governed file tools. |
| `paths.deny` | `string[]` | `[]` | Glob denylist; checked before allowlist. |
| `tools.deny` | `string[]` | `[]` | Registry tool names to block entirely (e.g. `shell`, `delete_file`, `run_security_scan`). |
| `mcp.allow` | `string[]` | any configured MCP server | Allowlist of MCP server `id` fields from config. Empty array denies all MCP. |
| `network` | `"off" \| "endpoint-only" \| "on"` | `"on"` | Outbound network posture (see [network levels](#network-levels)). |
| `maxToolCalls` | positive integer | unlimited | Maximum tool calls per agent run across all iterations. |

**Command matching note:** patterns are `new RegExp(pattern)` — anchor explicitly
(e.g. `^npm test\\b`) to avoid accidental substring matches.

**Path matching note:** globs are anchored full-path matches after normalizing `\` to `/`.

**Tool names (common):** `shell`, `read_file`, `write_file`, `edit_file`, `delete_file`,
`list_files`, `search_text`, `git_status`, `git_diff`, `run_check`, `run_security_scan`,
`memory_search`, `memory_write`, `memory_update`, `memory_delete`, `memory_import`,
`list_skills`, `read_skill`, `project_scripts`, `list_remediation_cases`,
`prepare_remediation_worktree`.

---

## Recipes

Ready-to-copy policies validated against `orgPolicySchema`. Adjust provider/model ids
and MCP server ids to match your install.

### Locked-down finance

Chat and Cowork only — no autonomous Code mode. Shell is allowlist + default-deny,
secrets paths blocked, dangerous tools and all MCP denied, network fully off.

**Machine policy** (`~/.dvalincode/policy.json`):

```json
{
  "modes": ["chat", "cowork"],
  "providers": {
    "allow": ["openai"]
  },
  "models": {
    "allow": ["gpt-4o-mini"]
  },
  "commands": {
    "allow": [
      "^npm test\\b",
      "^npm run lint\\b",
      "^git status\\b",
      "^git diff\\b"
    ],
    "deny": ["^curl\\b", "^wget\\b", "^rm\\b", "^ssh\\b", "^scp\\b"],
    "defaultDeny": true
  },
  "paths": {
    "allow": ["src/**", "tests/**", "docs/**"],
    "deny": ["**/.env*", "secrets/**", "**/*.pem", "**/*.key", "infra/credentials/**"]
  },
  "tools": {
    "deny": ["shell", "memory_write", "memory_import", "delete_file"]
  },
  "mcp": {
    "allow": []
  },
  "network": "off",
  "maxToolCalls": 25
}
```

**Optional repo narrowing** (`dvalin.policy.json` in the repo root) — team removes
Cowork so only read-only Chat remains:

```json
{
  "modes": ["chat"],
  "paths": {
    "deny": ["payments/**", "compliance/**"]
  }
}
```

### Endpoint-only default

Enterprise baseline: all modes, approved providers, dangerous shell patterns blocked,
secret paths denied, model endpoint reachable but no arbitrary egress.

```json
{
  "modes": ["chat", "cowork", "code"],
  "providers": {
    "allow": ["deepseek", "openai", "groq"]
  },
  "commands": {
    "deny": ["^curl\\b", "^wget\\b", "^nc\\b", "^ssh\\b", "^scp\\b"]
  },
  "paths": {
    "deny": ["**/.env*", "secrets/**", "**/*.pem", "**/*.key"]
  },
  "network": "endpoint-only",
  "maxToolCalls": 100
}
```

### Permissive dev

Light guardrails for trusted developer machines — block catastrophic shell and the
most sensitive dotenv files; everything else stays open.

```json
{
  "commands": {
    "deny": ["^rm -rf\\b"]
  },
  "paths": {
    "deny": ["**/.env", "**/.env.local"]
  },
  "network": "on"
}
```

---

## Narrowing walk-through

Machine policy sets `network: endpoint-only` and `modes: [chat, cowork]`. A developer
commits a repo policy with `network: on` and `modes: [chat, cowork, code]`.

**Effective result:** `network` stays `endpoint-only`, `modes` stay `[chat, cowork]`.
The repo file cannot widen IT constraints — only add denials or intersect allowlists.

Run `dvalincode trust` from the repo root to see both source hashes and the effective
fields side by side.

---

## Related docs

- [Approvability plan](APPROVABILITY-PLAN.md) — why policy exists and epic acceptance criteria
- [Egress threat model](EGRESS-THREAT-MODEL.md) — network enforcement mechanics
- [Governed MCP](GOVERNED-MCP.md) — MCP allowlist and trust surface
- [Threat model](THREAT-MODEL.md) — agentic risks policy defends against
