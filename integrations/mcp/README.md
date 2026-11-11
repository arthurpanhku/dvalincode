# Editors and MCP

```sh
npx dvalincode mcp-install codex         # ~/.codex/config.toml via Codex's CLI
npx dvalincode mcp-install cursor        # .cursor/mcp.json
npx dvalincode mcp-install vscode        # .vscode/mcp.json
npx dvalincode mcp-install claude-code   # .mcp.json
npx dvalincode mcp-install gemini        # .gemini/settings.json, or ~/.gemini/settings.json
npx dvalincode mcp-install opencode      # opencode.json, or ~/.config/opencode/opencode.json
```

`--print` shows the file or command without writing it, `--global` writes the user-level
config where the editor has one, and `--workspace <dir>` bounds what the server
is allowed to read.

For Codex, the command invokes the official `codex mcp add` config writer. Codex
shares this user-level MCP configuration between its CLI and IDE extension, so
there is no JSON file for Dvalin to merge and `--global` is unnecessary.

## Every agent on this machine at once

```sh
npx dvalincode agents                 # what is installed, and where Dvalin already is
npx dvalincode agents connect         # the plan; nothing is written
npx dvalincode agents connect --yes   # apply it
```

`agents` counts an agent as installed when its command is on `PATH`, the
directory it creates in your home folder exists (`~/.codex`, `~/.gemini`, …), or
its macOS app bundle is present. It runs nothing and writes nothing. It then
reads each agent's project and user configs, and for Claude Code also the user
and local scopes `claude mcp add` keeps in `~/.claude.json`, to say where Dvalin
is already configured. A config it cannot parse, such as an `opencode.jsonc` with
comments, is reported as unreadable rather than as unconfigured.

`agents connect` covers every installed agent that has no Dvalin entry anywhere;
name agents to pick them yourself (`agents connect codex gemini`). It takes the
same `--global`, `--workspace` and `--name` options as `mcp-install` and writes
exactly what `mcp-install` would.

## CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) keeps one list of MCP
servers and syncs it into the agents it manages. To put Dvalin on that list:

```sh
npx dvalincode agents connect cc-switch         # shows the link
npx dvalincode agents connect cc-switch --yes   # opens it
```

The link is CC Switch's own `ccswitch://v1/import?resource=mcp` deep link. CC
Switch displays the server it carries, asks before importing, and then writes it
into each app listed. Dvalin lists the agents it found that CC Switch can sync MCP
into: Claude Code, Codex, Gemini CLI and OpenCode. If CC Switch already has a
server named `dvalin`, it keeps that server's config and only adds the new apps,
so use `--name` for a second entry. Dvalin never reads or writes CC Switch's
database.

To use CC Switch's local routing as Dvalin's own model provider, start routing for
Codex in CC Switch, then:

```sh
npx dvalincode provider set cc-switch   # http://127.0.0.1:15721/v1, key held by CC Switch
```

CC Switch serves `/v1/chat/completions` as its Codex app, so Dvalin's requests go
to whichever provider Codex is routed to.

## Why a command rather than a snippet

The formats are not the same, and the difference is silent:

| Editor | File | Servers key / writer |
|---|---|---|
| Codex | `~/.codex/config.toml` | `codex mcp add` |
| Cursor | `.cursor/mcp.json`, or `~/.cursor/mcp.json` | `mcpServers` |
| VS Code | `.vscode/mcp.json` | **`servers`** |
| Claude Code | `.mcp.json` | `mcpServers` |
| Gemini CLI | `.gemini/settings.json`, or `~/.gemini/settings.json` | `mcpServers` |
| OpenCode | `opencode.json`, or `~/.config/opencode/opencode.json` | **`mcp`**, with `type: "local"` and the command line in one array |

Put `mcpServers` in a VS Code file and it is accepted, ignored, and the tools
never appear — no error to search for. The command exists so nobody has to know
that. It merges into whatever is already in the file, so other servers and
settings survive.

OpenCode has two shapes. V2 groups servers under `mcp.servers`, while V1 puts
them directly under `mcp`. V2 still reads the V1 shape, and V1 cannot read V2's,
so Dvalin writes V1. An existing `dvalin` entry under `mcp.servers` is updated in
place instead, so the server is never defined twice.

`dvalin.mcp.json` in this directory is the `mcpServers` shape, for a client that
takes a config blob directly.

## Editors with their own command

`mcp-install codex` wraps the Codex command below; both write the same thing and
let Codex validate its own configuration:

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
