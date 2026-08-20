# DvalinCode in Claude Code

Two independent ways to use them together. The MCP server is the richer one; the
skill works with nothing but `npx`.

## MCP server

```sh
claude mcp add dvalin -- npx -y dvalincode mcp-serve --workspace .
```

That lands in your user config for this project and connects immediately.

Or commit a `.mcp.json` so the whole team gets it:

```json
{
  "mcpServers": {
    "dvalin": {
      "command": "npx",
      "args": ["-y", "dvalincode", "mcp-serve", "--workspace", "."]
    }
  }
}
```

**A `.mcp.json` does not connect until you approve it.** `claude mcp list` shows
it as `⏸ Pending approval (run \`claude\` to approve)` until then. That is
deliberate on Claude Code's part — a config file arriving with a repository is
untrusted input, and it should not be able to start a process on your machine
because you cloned something. Run `claude` once in the project and approve.

If you would rather skip that for your own machine, `--scope local` keeps the
entry in your user config instead, where it needs no approval.

This exposes seven tools:

| Tool | Needs a model? | Notes |
|---|---|---|
| `dvalin_scan` | no | Does not edit the workspace; returns structured findings and persists a compact workflow. Pass `diff: "uncommitted"` to report only on what you just wrote. |
| `dvalin_get_finding` | no | Reads one finding by workflow ID and fingerprint. |
| `dvalin_verify_findings` | no | Re-scans and applies the deterministic verification gate. |
| `dvalin_list_scanners` | no | Reports scanner readiness and fixed install commands. |
| `dvalin_run_task` | yes | Delegates a whole governed coding task; needs DvalinCode's provider configured. |
| `dvalin_get_session` | no | Session summary and its audit anchor. |
| `dvalin_get_evidence` | no | The Markdown audit trail for a run. |

`--workspace` bounds what the server will touch; a call naming a path outside it
is refused.

## Skill

Copy the skill into a project or your home directory:

```sh
mkdir -p .claude/skills
cp -R integrations/claude-code/skills/dvalin-security-scan .claude/skills/
```

It teaches Claude when to scan, how to read the result, and — as importantly —
not to declare code secure because a scan came back clean.

The skill uses `npx -y dvalincode` when no MCP server is configured, so it works
with nothing installed. With the MCP server configured it uses `dvalin_scan`
instead, which is faster since there is no per-call process start.

## Verified

Both clients were checked end to end against the published package, driving a
real tool call rather than only a handshake:

| Client | Server command | Result |
|---|---|---|
| Claude Code 2.1.226 | `npx -y dvalincode mcp-serve` | `mcp__dvalin__dvalin_scan` called, correct findings returned |
| Claude Code 2.1.226 | `node dist/index.js mcp-serve` | connected |
| Codex 0.147.0 | `npx -y dvalincode mcp-serve` | `dvalin/dvalin_scan` called, correct findings returned |
| Codex 0.147.0 | `node dist/index.js mcp-serve` | `dvalin/dvalin_scan` called, correct findings returned |

The fixture was a file containing `eval(req.body.e)`; both clients reported
`vuln.js` line 2, rule `dvalin/eval`, score 88 grade B — the scanner's own
numbers, not something either model could infer from reading the file.

Codex configures the same server with `codex mcp add dvalin -- npx -y
dvalincode mcp-serve --workspace .`, which writes `[mcp_servers.dvalin]` into
`~/.codex/config.toml`.
