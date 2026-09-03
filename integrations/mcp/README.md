# Editors and MCP

```sh
npx dvalincode mcp-install cursor        # .cursor/mcp.json
npx dvalincode mcp-install vscode        # .vscode/mcp.json
npx dvalincode mcp-install claude-code   # .mcp.json
```

`--print` shows the file without writing it, `--global` writes the user-level
config where the editor has one, and `--workspace <dir>` bounds what the server
is allowed to read.

## Why a command rather than a snippet

The formats are not the same, and the difference is silent:

| Editor | File | Servers key |
|---|---|---|
| Cursor | `.cursor/mcp.json`, or `~/.cursor/mcp.json` | `mcpServers` |
| VS Code | `.vscode/mcp.json` | **`servers`** |
| Claude Code | `.mcp.json` | `mcpServers` |

Put `mcpServers` in a VS Code file and it is accepted, ignored, and the tools
never appear — no error to search for. The command exists so nobody has to know
that. It merges into whatever is already in the file, so other servers and
settings survive.

`dvalin.mcp.json` in this directory is the `mcpServers` shape, for a client that
takes a config blob directly.

## Editors with their own command

Prefer these where they exist; they write the same thing and validate it:

```sh
claude mcp add dvalin -- npx -y dvalincode mcp-serve --workspace .
codex mcp add dvalin -- npx -y dvalincode mcp-serve --workspace .
```

A `.mcp.json` arriving with a repository is untrusted until approved — Claude
Code shows it as `⏸ Pending approval` until you run `claude` once in the project
and approve it. That is deliberate on its part: cloning a repository should not
start a process on your machine.

Claude also requires explicit tool permission after the server is trusted. To
pre-approve only the read-only preview for one invocation, use:

```sh
claude --allowedTools 'mcp__dvalin__dvalin_scan'
```

`dvalin_begin_verification` remains separate and state-changing, so accepting a
preview does not silently accept local workflow creation.

## Other editors

Windsurf and Zed both speak stdio MCP and should work with the same server
command, but their config formats are not covered here because they could not be
confirmed against current documentation. Use their own MCP settings UI, with:

```
command: npx
args:    -y dvalincode mcp-serve --workspace .
```

If you get one working, a pull request adding it to `src/mcp/install.ts` is
welcome — the shape is a single entry in `CLIENTS`.
