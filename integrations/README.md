# Integrations

Ways to reach DvalinCode from something other than its own CLI.

| Path | What it is |
|---|---|
| [`claude-code/`](claude-code/) | A Claude Code skill that runs a Dvalin scan and reads the result. |
| [`../editors/vscode/`](../editors/vscode/) | The VS Code extension — findings in the Problems panel. |
| [`../action.yml`](../action.yml) | The GitHub Action — findings on the pull request diff. |
| `dvalincode mcp-serve` | The MCP server, for any agent that speaks MCP. See the repository README. |

## Two different things called "skills"

- **DvalinCode skills** are DvalinCode's own portable instruction bundles, a
  JSON format stored under `~/.dvalincode/skills`. See [docs/SKILLS.md](../docs/SKILLS.md).
- **Claude Code skills** are Anthropic's `SKILL.md` directory format, loaded by
  Claude Code. That is what lives in `claude-code/skills/`.

They are unrelated formats that happen to share a word.
