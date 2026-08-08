# DvalinCode in Claude Code

Two independent ways to use them together. The MCP server is the richer one; the
skill works with nothing but `npx`.

## MCP server

```sh
claude mcp add dvalin -- npx -y dvalincode mcp-serve --workspace .
```

Or in `.mcp.json`:

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

This exposes four tools:

| Tool | Needs a model? | Notes |
|---|---|---|
| `dvalin_scan` | no | Read-only, deterministic, no credentials. Safe to call after every edit. |
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
