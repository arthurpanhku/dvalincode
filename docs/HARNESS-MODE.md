# Harness Mode: headless `run`, MCP server, unattended tier

## Scope

Make DvalinCode drivable by **external harnesses** — CI pipelines, eval
harnesses, schedulers (cron, Claude Code `/loop`), and other agents — without
weakening the governance chokepoint. Three phases, strictly ordered:

1. **Phase 1 — `dvalincode run`**: a headless, non-interactive CLI command with
   machine-readable output and deterministic exit codes. This is the primitive
   every harness consumes.
2. **Phase 2 — MCP server**: expose DvalinCode as an MCP server (stdio) so other
   agents can delegate governed coding tasks to it. A thin wrapper over the same
   core as Phase 1.
3. **Phase 3 — unattended tier**: policy + evidence semantics for runs with no
   human present. We do **not** build a scheduler; we make each scheduled run
   bounded and auditable.

**Non-goals**: a scheduler/daemon, exposing atomic tools (read/write/shell) over
MCP, HTTP transport for the MCP server (stdio only in v1), OAuth, MCP
resources/prompts/sampling.

## Why this shape

`runAgentTurn` (`src/agent/session.ts`) is already the single governed entry
point shared by the web GUI, the TUI, and the SWE-bench eval driver
(`eval/swebench/agent-driver.mjs`): org policy resolution, per-run audit chain
(`run_start` → tool events → `run_end`), approval-mode chokepoint, and durable
sessions all live behind it. The eval driver is proof that harnesses need this
entry point — and proof that today they can only reach it by importing from
`dist/` with hand-written glue. Phase 1 promotes that glue to a supported,
tested CLI surface; Phase 2 puts an MCP facade on the same surface.

The strategic point for the governance lane: a customer's general-purpose agent
may not be approvable, but it can **delegate the code-touching work to
DvalinCode**, where every action passes the policy chokepoint, lands in the
tamper-evident audit, and respects the egress guard. DvalinCode becomes the
*governed executor inside someone else's harness*.

---

## Phase 1 — `dvalincode run` (headless, non-interactive)

### Command surface

New file `src/commands/run.ts`, registered in `src/cli.ts` (same pattern as
`registerChatCommand`).

```
dvalincode run [prompt...]                     # prompt as argv
echo "fix the bug" | dvalincode run -          # prompt from stdin
dvalincode run --prompt-file task.md           # prompt from file

Options:
  --session <id>                resume an existing session (sessions/store.js)
  --cwd <dir>                   workspace root (default: process.cwd())
  --mode <chat|cowork|code>     AgentMode (default: code)
  --permission-mode <plan|auto|bypass>
                                CodePermissionMode (default: auto).
                                'ask' is rejected: run is non-interactive.
  --provider <name> / --model <name> / --profile <name>
                                same resolution as chat.ts
  --output-format <text|json|stream-json>      (default: text)
  --include-deltas              stream-json only: include token_delta events
  --max-iterations <n>          TurnConfig.maxIterations override (default 40)
  --max-tool-calls <n>          TurnConfig.maxToolCallsPerTurn override
  --timeout <minutes>           wall-clock cap via AbortSignal.timeout (default 25)
  --report <file>               write the run report markdown to a file
  --quiet                       suppress stderr progress lines
```

### Implementation

The action is a thin composition — **do not duplicate chat.ts's provider/policy
setup; call `runAgentTurn`** exactly as `agent-driver.mjs` does today:

- Resolve prompt (argv join, `-` for stdin, or `--prompt-file`; exactly one
  source or exit 2).
- `runAgentTurn({ content, cwd, mode, codePermissionMode, sessionId?, signal:
  AbortSignal.timeout(...) }, { onEvent, onProviderSelected })` with
  `config: { maxIterations, maxToolCallsPerTurn }` overrides threaded through
  (extend `RunTurnInput` with an optional `config?: Partial<TurnConfig>` if it
  does not already accept one).
- **stdout is data, stderr is progress.** Human-readable progress lines
  (`[12s] tool#3 shell …`, as in agent-driver.mjs) go to stderr; the result/
  events go to stdout. `--quiet` silences stderr.

### Non-interactive guarantee

`run` must **never block on a prompt**. `--permission-mode ask` is rejected at
parse time (exit 2). Audit the mode as usual; `run_start.mode` already records
the resolved approval mode. If any code path would ask for confirmation under
the chosen mode, it must fail the tool call (recorded as `tool_error` in the
audit) rather than hang.

### Output formats

**`text`** (default): final response to stdout, then the same session/audit
trailer chat.ts prints.

**`json`**: single JSON object on stdout after completion:

```json
{
  "ok": true,
  "sessionId": "…", "runId": "…", "auditHead": "…",
  "policyHash": "…",
  "provider": "…", "model": "…",
  "iterationsUsed": 7, "toolCalls": 12,
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "wallSeconds": 92.4,
  "output": "final assistant message",
  "stopReason": "done | max_iterations | timeout | interrupted | error",
  "error": "present only when ok=false"
}
```

This is a superset of what `agent-driver.mjs` writes today — keep field names
identical (`sessionId`, `runId`, `auditHead`, `iterationsUsed`, `usage`,
`toolCalls`, `wallSeconds`, `output`) so the eval harness migration is
mechanical.

**`stream-json`**: NDJSON on stdout, one event per line, mapped from
`AgentEvent` (`src/agent/types.ts`) plus an envelope:

```
{"type":"run_start","sessionId":"…","runId":"…","provider":"…","model":"…","policyHash":"…"}
{"type":"llm_iteration","iteration":1}
{"type":"tool_call","name":"read_file","id":"…","input":{…}}
{"type":"tool_result","name":"read_file","id":"…","output":"…"}
{"type":"tool_error","name":"shell","id":"…","error":"…"}
{"type":"token_delta","content":"…"}          # only with --include-deltas
{"type":"result", …same object as --output-format json…}
```

The `result` line is always last. Tool outputs may be large; truncate
`tool_result.output` to 4 KB per event with a `truncated: true` marker (the
full output is in the audit trail — do not duplicate it on the wire).

### Exit codes

<a name="exit-codes"></a>These apply to **every** command, not only `run`.
They live in `src/core/exitCodes.ts`; nothing should write a bare number.

| Code | Meaning | Examples |
|------|---------|----------|
| 0 | completed, and the answer was yes | a clean scan, an intact audit chain |
| 1 | the command tried and something broke | provider error, tool crash, failed update |
| 2 | the invocation was wrong | bad flag, missing argument, unknown session, unreadable input file |
| 3 | org policy said no | `PolicyViolationError` — denied provider, model, mode, tool, command, or path |
| 4 | timeout or interrupt | wall-clock limit, SIGINT, aborted run |
| 5 | it ran correctly and the answer was no | findings at or above `--fail-on`, an Evidence Pack that did not verify, a broken audit chain, an invalid policy |

**5 exists so a pipeline can tell three different things apart.** "We found
security problems", "the scanner crashed", and "you typed the flag wrong" are
different events that need different responses, and before 0.17.0 the first two
of those shared a code with the third depending on which command you ran:
`dvalin --fail-on` exited 2, which also meant a bad flag, while
`evidence verify` exited 1, which also meant a crash.

The interactive TUI still exits 130 on SIGINT, which is the Unix convention
(128 + signal) rather than part of this scheme.

On every non-zero exit with `--output-format json|stream-json`, still emit the
`result` object (`ok: false`, `error`, `stopReason`) before exiting — harnesses
must never have to parse stderr.

### Migration: eval driver

Rewrite `eval/swebench/agent-driver.mjs` (or replace its call sites in
`run-one.sh`) to invoke
`dvalincode run --prompt-file … --permission-mode bypass --timeout $AGENT_TIMEOUT_MIN --output-format json > out.json`.
Delete the `dist/` import glue. The eval harness becomes the first consumer and
the de-facto integration test.

### Tests (vitest, alongside existing suites)

- Flag validation: no prompt → exit 2; `--permission-mode ask` → exit 2;
  unknown `--session` → exit 2.
- With a mock provider adapter: `json` result shape; `stream-json` emits
  `run_start` first and `result` last; exit codes 0/1/3/4 paths; stdout/stderr
  separation; `tool_result` truncation marker.
- Policy: a policy denying the model exits 3 with `ok:false` JSON.

### Acceptance (Phase 1)

`echo "list the files in src and summarize" | dvalincode run - --output-format stream-json`
streams NDJSON, exits 0, and `dvalincode report --last` shows the run with the
same `runId` as the `result` line.

---

## `tools --json` — what is callable, and how

Capability discovery. `--json` reports every tool with the JSON Schema needed
to build its input:

```sh
dvalincode tools --json
```

```json
{ "tools": [
  { "name": "list_files", "access": "read", "description": "...",
    "parameters": { "type": "object", "properties": { "pattern": { "type": "string" } },
                    "required": ["pattern"] },
    "requiresYes": false } ] }
```

`parameters` is produced by the same helper the agent loop and the runner use,
so a caller reading it gets exactly the schema the model is given. If those
forked, an agent would build inputs the model would never produce.

`requiresYes` is true for `write` and `execute` tools — the ones `run-tool`
refuses without `--yes`, reporting `permission_denied`.

Together with `run-tool --json` this closes the loop: discover a tool, read its
schema, build an input, call it, and read a structured result — without parsing
prose at any step.

The text output is unchanged in shape, but its columns are now sized from the
longest name rather than a fixed width, which a long tool name used to overflow.

## `run-tool --json` — one tool, machine-readable

`dvalincode run` drives a whole governed turn. When a caller wants a single
tool instead, `run-tool` takes JSON in; `--json` makes it give JSON back.

```sh
dvalincode run-tool list_files -i '{"pattern":"src/**/*.ts"}' --json
```

```json
{ "ok": true, "tool": "list_files", "title": "Listed 42 files",
  "output": "...", "metadata": { "totalMatches": 42 } }
```

Failures use the same envelope, with a code that is decided **structurally** —
from a typed error or the registry's own metadata, never by matching an error
message, so rewording a message cannot silently reclassify a failure:

| `error.code` | Cause |
|---|---|
| `invalid_input` | `-i` was not valid JSON |
| `unknown_tool` | no such tool, or it is outside the allowed set |
| `invalid_tool_input` | JSON parsed, but failed the tool's schema |
| `permission_denied` | the tool writes or executes and `--yes` was absent |
| `policy_denied` | org policy blocked the tool, command, or path |
| `tool_error` | the tool itself failed |

Exit code is 0 on success and 1 on any failure. Diagnostics — including the
malformed-policy warning — go to stderr, so stdout stays parseable.

Without `--json` the behaviour is unchanged: prose on stdout, the original
error thrown. That matters beyond formatting — `PolicyViolationError` is what
proves enforcement to a caller, and it is rethrown rather than wrapped.

## Phase 2 — MCP server (stdio)

### Shape

New `src/mcp/server.ts` + `src/commands/mcpServe.ts` registering
`dvalincode mcp-serve`. **Stdio transport, hand-rolled JSON-RPC 2.0** —
consistent with the zero-runtime-deps posture already established by the
hand-rolled client (`docs/GOVERNED-MCP.md`). Only three methods are required:
`initialize`, `tools/list`, `tools/call` (reject others with
`-32601 Method not found`). Content-Length framing is not used by stdio MCP;
messages are newline-delimited JSON per the spec.

Harness side registration example (Claude Code):

```json
{ "mcpServers": { "dvalincode": { "command": "dvalincode", "args": ["mcp-serve"] } } }
```

### Tool surface — task-level only

**Do not expose atomic tools (read_file/write_file/shell) over MCP.** Exposing
them would hand the loop — and therefore the governance chokepoint — to the
external harness. The loop, tool selection, and approval logic stay inside
DvalinCode. v1 tools:

1. **`dvalin_run_task`** — the workhorse. Input schema:
   `{ prompt: string, cwd?: string, permission_mode?: "plan"|"auto"|"bypass",
   session_id?: string, max_iterations?: number, timeout_minutes?: number }`.
   Runs `runAgentTurn` (same path as Phase 1) and returns the Phase-1 `result`
   JSON as the tool result text. Synchronous in v1; long calls are expected —
   document that callers should set generous timeouts. Annotate
   `readOnlyHint: false`.
2. **`dvalin_get_session`** — `{ session_id: string }` → session summary +
   message count + last `runId`/`auditHead`. `readOnlyHint: true`.
3. **`dvalin_get_evidence`** — `{ run_id?: string }` (default: last run) →
   the run report markdown (same content as `dvalincode report`).
   `readOnlyHint: true`. This is the differentiator: the calling agent can
   attach DvalinCode's audit evidence to its own output.

### Governance rules specific to the server

- **Permission-mode ceiling.** The MCP caller may request a narrower
  `permission_mode` than the server's launch configuration but never a broader
  one. `dvalincode mcp-serve --max-permission-mode auto` (default `auto`;
  `bypass` must be explicitly granted at launch by the human/config, mirroring
  the narrowing rule from `docs/POLICY-REFERENCE.md`). A `dvalin_run_task`
  requesting more than the ceiling fails with a policy error in the tool
  result — never silently downgraded without saying so.
- **cwd allowlist.** `--workspace <dir>` (repeatable) at launch; `cwd` in
  `dvalin_run_task` must resolve inside an allowed workspace, else the call
  fails. Default: the cwd where `mcp-serve` was started.
- **Audit provenance.** Extend the `run_start` audit event with
  `origin: "cli" | "gui" | "tui" | "mcp-serve"` so the tamper-evident chain
  records *who was driving*. (Additive field; existing consumers unaffected.)
- **Org policy still binds.** Everything inside `dvalin_run_task` goes through
  the same `loadPolicy`/`checkProvider`/`checkModel`/`registry.run` chokepoints
  as any other entry — the MCP server adds no second policy engine and no
  bypass.

### Tests

- Protocol: `initialize` → `tools/list` returns exactly the three tools with
  schemas; unknown method → `-32601`; malformed JSON → `-32700`.
- Ceiling: launch with default ceiling, `dvalin_run_task` with
  `permission_mode: "bypass"` → tool-level error mentioning the ceiling.
- cwd outside allowlist → tool-level error.
- End-to-end with mock provider: `dvalin_run_task` returns the Phase-1 result
  shape; the audit file for the run has `origin: "mcp-serve"`.

### Acceptance (Phase 2)

From Claude Code with the server registered: asking it to
"use dvalincode to add a comment to README and show me the evidence" performs
the edit via `dvalin_run_task` and returns audit evidence via
`dvalin_get_evidence`, and `dvalincode report --last` on the host shows
`origin: mcp-serve`.

---

## Phase 3 — unattended tier (loops without a babysitter)

No scheduler. cron, CI, and Claude Code `/loop` all drive `dvalincode run`;
our job is to make each unattended run **bounded, fail-fast, and evidenced**.

1. **Policy dimension.** Add an `unattended` block to `dvalin.policy.json`
   (documented in `docs/POLICY-REFERENCE.md`, resolved by the same narrowing
   rule): `{ "maxPermissionMode": "auto", "maxIterations": 40,
   "maxWallMinutes": 30 }`. `dvalincode run` (and `dvalin_run_task`) applies it
   whenever stdin is not a TTY or `--unattended` is passed explicitly — flags
   may narrow further but never exceed it. Exceeding caps → exit 3.
2. **Fail-fast, never hang.** Already guaranteed by Phase 1's non-interactive
   rule; restated here because it is the load-bearing property for loops.
3. **Evidence per iteration.** `--report <file>` (Phase 1) writes the run
   report; document the loop recipe:
   `dvalincode run --prompt-file task.md --report "reports/$(date +%s).md"` in
   cron/CI. Each iteration leaves one audit chain + one report artifact — the
   pitch is "autonomous agent loops where every iteration is audit-evidenced."
4. **Docs.** A short `docs/RECIPES-UNATTENDED.md` (or a section here) with
   three worked examples: cron nightly dependency-bump, CI post-merge fixup,
   Claude Code `/loop` delegating to `dvalin_run_task`.

### Acceptance (Phase 3)

A policy with `"unattended": { "maxPermissionMode": "auto" }` causes
`dvalincode run --permission-mode bypass` from a non-TTY to exit 3, while the
same command from a TTY (or with the policy absent) behaves as in Phase 1.

---

## Sequencing and estimates

| Phase | Blocks on | New files | Touched files |
|-------|-----------|-----------|---------------|
| 1 | — | `src/commands/run.ts` | `src/cli.ts`, `src/agent/session.ts` (config passthrough), `eval/swebench/*` |
| 2 | Phase 1 | `src/mcp/server.ts`, `src/commands/mcpServe.ts` | `src/cli.ts`, `src/audit/log.ts` (origin field) |
| 3 | Phase 1 | — | `src/core/policy.ts`, `src/commands/run.ts`, `docs/POLICY-REFERENCE.md` |

Phase 1 is the majority of the value and the smallest diff — ship it alone
first. Phase 2 and 3 are independent of each other once Phase 1 lands.
