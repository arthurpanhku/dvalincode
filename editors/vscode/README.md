# Dvalin Security Scan — VS Code extension

Security findings in the Problems panel, on the lines that caused them. Scanning
needs no API key, no model, and no account.

![Problems panel with Dvalin findings](https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/assets/logo.png)

## What it does

- **Scans on open and on save.** Findings appear as squiggles and in Problems,
  the same as a compiler error. You do not have to open a chat or write a prompt.
- **Bands severity exactly like the CLI.** A finding shown as an error is the one
  `dvalincode dvalin . --fail-on high` would block in CI, so the editor and the
  pipeline never disagree about what "high" means.
- **Links the rule.** Each finding's rule id opens its CWE or rule reference.
- **Offers a governed repair.** The quick fix runs
  `dvalincode dvalin . --fix --verify` in a terminal — visible, interruptible,
  and gated on your tests passing and a clean re-scan.

## Install

From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=arthurpanhku.dvalincode-vscode),
or from [Open VSX](https://open-vsx.org/extension/arthurpanhku/dvalincode-vscode)
if you use Cursor, Windsurf, or VSCodium:

```sh
code --install-extension arthurpanhku.dvalincode-vscode
```

Every release also attaches a `.vsix` to the
[GitHub Release](https://github.com/arthurpanhku/dvalincode/releases), which
installs with `code --install-extension dvalin-security-scan.vsix`.

## Requirements

The Dvalin CLI. Either install it:

```sh
npm install -g dvalincode
```

or set `dvalin.command` to `npx -y dvalincode` and skip the install entirely.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `dvalin.command` | `dvalincode` | Set to `npx -y dvalincode` to run without installing. |
| `dvalin.scanners` | `builtin` | Add `semgrep`, `trivy`, `osv-scanner` when they are on `PATH`. |
| `dvalin.scanScope` | `changed` | `changed` reports only lines you have not committed yet; `workspace` reads everything. Needs a git repository. |
| `dvalin.scanOnSave` | `true` | Re-scan on save. |
| `dvalin.timeoutSeconds` | `60` | Abandon a scan that runs longer. |

Only `builtin` runs with no extra setup, which is why it is the default — it
keeps the on-save scan fast. Engines that are not installed are reported once
and never fail the scan.

## Why the fix runs in a terminal

Scanning is deterministic and local. **Fixing is not**: it uses your configured
model, edits files, and runs your tests. The extension deliberately does not do
that silently in the background — it opens a terminal so you can watch it, stop
it, and read the diff. That is the same reason the CLI keeps repair behind an
explicit `--fix`.

Nothing is auto-merged, and a clean scan is never treated as proof the code is
safe.

## Development

```sh
npm install
npm run check     # typecheck + unit tests
npm run build     # bundle to dist/extension.js
```

The scan and mapping logic lives in `src/scan.ts` and `src/findings.ts`, neither
of which imports `vscode`, so both are unit-tested without an extension host.
`tests/integration.test.ts` checks the JSON contract against the real published
CLI; it is skipped unless `DVALIN_E2E=1`.

## License

MIT — see [LICENSE](https://github.com/arthurpanhku/dvalincode/blob/main/LICENSE).
