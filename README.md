<p align="center">
  <img src="assets/logo.png" alt="DvalinCode" width="480">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">中文</a> · <a href="https://dvalincode.dev">dvalincode.dev</a>
</p>

<p align="center">
  <a href="https://github.com/arthurpanhku/dvalincode/releases/latest"><img src="https://img.shields.io/github/v/release/arthurpanhku/dvalincode?style=for-the-badge&color=818cf8&label=Release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/arthurpanhku/dvalincode"><img src="https://api.scorecard.dev/projects/github.com/arthurpanhku/dvalincode/badge" alt="OpenSSF Scorecard"></a>
</p>

<h3 align="center">Scanners find. Agents fix. Dvalin decides whether the fix is real.</h3>

<p align="center">The open-source, vendor-neutral referee for security fixes.<br>Every verdict is reached on your machine, and stays there.</p>

Your coding agent says it fixed the vulnerability. Dvalin checks. It re-scans
with the scanners your CI gate already runs, runs your project's own tests
itself, and reads the exit codes. No model has a say in the verdict, least of
all the one that wrote the fix. You get a **Verified Fix Record**: a small JSON
file anyone can re-check offline.

```sh
npx dvalincode security scan .    # 30 seconds: no install, no account, no API key
```

## The loop it ends

A scanner blocks your pull request. You hand the finding to a coding agent. Its
patch goes back to CI, and the scanner blocks it again: the finding is still
there, the patch added a new one, or the agent silenced the scanner instead of
fixing the code. Someone relays scanner output and rebases by hand, round after
round.

Dvalin takes the referee's seat in that loop. It tells the fixer exactly what is
still wrong, judges every round with the yardstick CI uses, and stops only when
the fix holds up.

## Where Dvalin sits

| | Finds issues | Writes the fix | Decides the fix is real |
|---|:---:|:---:|:---:|
| **Scanners**: Semgrep, Snyk, CodeQL, Trivy, OSV-Scanner | ✓ | | |
| **Coding agents**: Claude Code, Codex, Cursor, Copilot, or a person | | ✓ | |
| **Security agents from model vendors**: Codex Security, Claude Security | ✓ | ✓ | inside their product |
| **Dvalin** | runs your scanners | hands the work to your agent | ✓ in the open, on your machine |

Dvalin is not another scanner and not another coding agent. It is the referee
between them, and its verdict is the same whichever agent wrote the fix.
Built-in rules make the first scan work with nothing installed, and a built-in
agent can act as the fixer; both are optional.

Security agents from model vendors find, fix and validate inside one product,
built on that vendor's models and API. Dvalin can import their findings and
judge their fixes like anyone else's. Its own verdict differs in three ways:

- **Open source.** The code that reaches the verdict is MIT-licensed, and the
  default scanners are open source too. You can read every rule the referee
  applies, run it yourself, and fork it.
- **Vendor-neutral.** Any agent, any scanner, any model provider, or no model at
  all. Reaching a verdict needs no account, no API key and no vendor's cloud.
- **Kept on your machine.** The scans, the checks Dvalin ran, the fix record and
  the hash-chained log of how the verdict was reached stay in your repository
  and `~/.dvalincode/`. By default the verdict sends no code anywhere; engines
  that upload source, such as Snyk Code, run only when you name them.

## Why the verdict holds up

- **No model in the verdict.** Dvalin decides from the exit codes of processes
  it started and from a re-scan by the engines your CI gate runs. It never asks
  the fixer how it went.
- **The fixer can't move the goalposts.** Ignores that a change adds (`.snyk`,
  `nosemgrep`, `nosec`, …) don't count when that change is judged. In CI, the
  checks, gate and scanners come from the base commit, so a pull request can't
  relax the rules it is judged by.
- **Silencing the scanner is not a fix.** Moving a sink to a sibling
  (`eval` → `new Function`), deleting the vulnerable file, deleting tests or
  removing assertions all fail.
- **Reproduce, then fix.** For code findings, a test must fail on the unfixed
  code and pass after the fix, unchanged.
- **Proof that travels.** The record re-derives offline, with no workspace and
  no network. In CI, the runner can re-execute the verification and sign what
  it observed.

```sh
dvalin verify-fix fix-record.json
```
```
Fix record 2c9d71ac03e0 · VERIFIED · scan-and-checks
  executor: claude-code (recorded, not consulted)
  targets: 1 before · 0 remaining
  coverage: complete → complete
  introduced: 0 (gate high/new)
  outcome: verified
  ✓ test: npm run test (exit 0)
  audit: run verify-36509f42 @ 414644c75af0
```

### What "verified" means, and what it doesn't

A record says something narrow on purpose: *these findings were present; after
the change, a re-scan no longer reported them; these commands ran, and Dvalin
observed these exit codes.* It does not say the code is safe. Every record
carries what the scan covered (`complete`, `partial` or `unknown`). A fix no
check could confirm does not pass. A fix that removes one finding and introduces
another is recorded as `regressed`. Evasion checks match known patterns; their
limits are listed under [honest gaps](docs/SECURITY-AGENT-STRATEGY.md#honest-gaps-today).
[The open profile, FVP-1 →](docs/spec/FIX-VERIFICATION.md)

## Use it where you already work

**In your coding agent.** Dvalin is an MCP server. Connect it to the agents on
this machine (Claude Code, Codex, Cursor, VS Code, Gemini CLI, OpenCode):

```sh
npx dvalincode agents connect         # preview what each agent would get
npx dvalincode agents connect --yes   # apply it
```

After writing a repair, the agent calls `dvalin_verify_findings` and gets a
Verified Fix Record back.

**On every pull request.** The GitHub Action needs no API key and no model:

```yaml
- uses: arthurpanhku/dvalincode@v0.24.0
  with:
    fail-on: high
    diff: true    # gate only what this pull request adds
```

Pass `fix-record:` and the runner re-derives the record and posts it beside the
diff. Add `reverify: true` and the runner re-executes the verification itself.
GitLab CI and pre-commit are in the [CLI guide](docs/cli.md).

**In the terminal.** Let Dvalin drive the fixer until the gate would pass:

```sh
dvalincode dvalin . --until-clean --max-rounds 3 --executor codex
```

Each round, Dvalin re-scans, runs your checks, and sends the executor only what
is still wrong. The loop stops when the fix verifies, the round budget runs out,
or progress stalls. Every outcome issues a fix record.

## A real run

<p align="center">
  <img src="assets/dvalin-remediation.gif" alt="Dvalin scanning a vulnerable OWASP NodeGoat example at 22/100 F with 10 findings, then showing a clean verified re-scan at 100/100 A" width="100%">
</p>

Recorded from the real application, not a mock. The input is adapted from
[OWASP NodeGoat](https://github.com/OWASP/NodeGoat/tree/c5cb68a7084e4ae7dcc60e6a98768720a81841e8/app/routes)
(Apache-2.0), whose contribution route evaluated user-controlled text.

| | Before | After |
|---|---:|---:|
| Security health (triage heuristic) | 22 / 100 · F | 100 / 100 · A |
| Findings | 10 (`eval` across 3 rules, 2 engines) | 0 |
| Tests | 2 passing | 3 passing, including an injection regression test |
| Scanner fleet | 4 / 4 completed | 4 / 4 completed |

## Install

Dvalin ships in the `dvalincode` package with two commands: `dvalin` for the
security workflow, and `dvalincode` for everything, including the built-in
agent.

**CLI** (macOS · Linux · Windows):

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
```

Homebrew, Windows and manual downloads are in the [CLI guide](docs/cli.md).

**Desktop app** (macOS · Windows): the same engine in a window, with the Dvalin
security workspace and the built-in agent. See the
[desktop app guide](docs/gui.md).

[Code signing policy](docs/CODE-SIGNING.md) · [Privacy notice](docs/PRIVACY.md).
Free Windows signing through SignPath Foundation is being prepared; approval
and production signing have not been confirmed.

[What's new in each release →](docs/whats-new.md)

## Is Dvalin for you?

**Yes, if**

- coding agents fix what your scanners report;
- you run more than one agent or scanner and want one verdict across them;
- you have to show an auditor that a repair worked;
- the verdict must be open, independent of any one AI vendor, and stay on your
  own machines.

**Probably not, if**

- you want a coding agent: use Claude Code, Codex or opencode, then connect
  Dvalin;
- you want the widest vulnerability discovery: use a dedicated scanner or AI
  security agent;
- you run one scanner with its own platform autofix, and nobody asks for proof.

## Documentation

- [CLI guide](docs/cli.md): gates, the fix loop, CI, MCP and headless runs
- [Desktop app guide](docs/gui.md)
- [How verification works (FVP-1)](docs/spec/FIX-VERIFICATION.md)
- [Dvalin security workspace](docs/DVALIN.md): scanners, SARIF and Codex Security import
- [The built-in agent](docs/agent.md): modes, tools, providers, architecture and FAQ
- [Trust and governance](docs/trust.md): org policy, audit trail, threat model and evidence
- [Security strategy](docs/SECURITY-AGENT-STRATEGY.md): what Dvalin competes on, and what it doesn't

## Contributing

Contributions are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the
governance rules and building from source. Thanks to everyone who has helped so
far: [@arthurpanhku](https://github.com/arthurpanhku),
[@shivasb42](https://github.com/shivasb42), [@adity982](https://github.com/adity982),
[@weed33834](https://github.com/weed33834), [@webdevsamran](https://github.com/webdevsamran),
[@dchaudhari7177](https://github.com/dchaudhari7177) and
[@TayfurYldz](https://github.com/TayfurYldz)
([full history](https://github.com/arthurpanhku/dvalincode/graphs/contributors)).

## License and attribution

MIT, see [LICENSE](LICENSE). DvalinCode is an independent project. It is not
affiliated with, sponsored by, or endorsed by any vendor or project named here,
including Anthropic, OpenAI and GitHub. The public research, open-source
projects and standards that informed it are credited in
[docs/REFERENCES.md](docs/REFERENCES.md).
