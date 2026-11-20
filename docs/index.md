---
layout: home

hero:
  name: DvalinCode
  text: Scanners find. Agents fix. Dvalin decides.
  tagline: The open-source, vendor-neutral referee for security fixes. Dvalin re-scans with the scanners your CI already runs, runs your tests itself, and reads the exit codes — on your machine — then hands you a record anyone can re-check offline.
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: DvalinCode
  actions:
    - theme: brand
      text: Try it in 30 seconds
      link: '#install'
    - theme: alt
      text: How verification works
      link: /spec/FIX-VERIFICATION
    - theme: alt
      text: GitHub
      link: https://github.com/arthurpanhku/dvalincode

features:
  - icon: ⚖️
    title: No model in the verdict
    details: Dvalin decides from the exit codes of processes it started and from a re-scan by the engines your CI gate runs. It never asks the fixer how it went.
    link: /spec/FIX-VERIFICATION
    linkText: The open profile
  - icon: 🥅
    title: The fixer can't move the goalposts
    details: Ignores that a change adds don't count when that change is judged. In CI, the checks, gate and scanners come from the base commit, so a pull request can't relax the rules it is judged by.
    link: /cli#measure-with-the-scanner-your-ci-gate-uses
    linkText: Same yardstick as CI
  - icon: 🔇
    title: Silencing the scanner is not a fix
    details: Moving a sink to a sibling, deleting the vulnerable file, deleting tests or removing assertions all fail. For code findings, a test must fail before the fix and pass after it, unchanged.
    link: /cli#let-it-loop-until-the-gate-would-pass
    linkText: The fix loop
  - icon: 🔏
    title: Proof that travels
    details: A Verified Fix Record re-derives offline with <code>dvalin verify-fix</code>, with no workspace and no network. In CI, the runner can re-execute the verification and sign what it observed.
    link: /cli#re-execute-it-on-the-runner-and-sign-what-you-saw
    linkText: Re-execute and sign
  - icon: 🔓
    title: Open source, on your machine
    details: The code that reaches the verdict is MIT-licensed and runs locally. No account, no API key, no vendor's cloud — the record and the log of how the verdict was reached stay with you.
    link: /trust
    linkText: Trust and governance
  - icon: 🔌
    title: Vendor-neutral
    details: Claude Code, Codex, Cursor and other MCP clients call Dvalin directly. Semgrep, Snyk, CodeQL, Trivy, OSV-Scanner, Codex Security or any SARIF producer feed the same gate, and judging needs no model at all.
    link: /cli#wherever-you-already-work
    linkText: Integrations
---

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
agent that ships with Dvalin's security skills can act as the fixer; both are
optional.

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

## Try it in 30 seconds {#install}

```sh
npx dvalincode security scan .    # no install, no account, no API key
```

To keep it, install the CLI and run the full scanner fleet:

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
dvalincode trust
dvalincode dvalin . --scanners builtin,semgrep,trivy,osv-scanner
```

The Dvalin command runs the built-in rules and any supported open-source engines
installed on `PATH`. Use `--fix --verify --record fix-record.json` to prepare
focused repairs, run the tests, and write out the record. Hand that record to
anyone:

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

Windows builds and manual downloads for every platform are on the
[releases page](https://github.com/arthurpanhku/dvalincode/releases/latest),
with `SHA256SUMS.txt` and build provenance attestation for each archive.

## What "verified" means, and what it doesn't

A record says something narrow on purpose: *these findings were present; after
the change, a re-scan no longer reported them; these commands ran, and Dvalin
observed these exit codes.* It does not say the code is safe. Every record
carries what the scan covered (`complete`, `partial` or `unknown`). A fix no
check could confirm does not pass — "there was nothing to run" is not a pass. A
fix that removes one finding and introduces another is recorded as
`regressed`. Evasion checks match known patterns; their limits are listed under
[honest gaps](/SECURITY-AGENT-STRATEGY#honest-gaps-today).
[The open profile →](/spec/FIX-VERIFICATION)

## Use it where you already work

**In your coding agent.** Dvalin is an MCP server. Connect it to the agents on
this machine (Claude Code, Codex, Cursor, VS Code, Gemini CLI, OpenCode):

```sh
npx dvalincode agents connect         # preview what each agent would get
npx dvalincode agents connect --yes   # apply it
```

After writing a repair, the agent calls `dvalin_verify_findings` and gets a
Verified Fix Record back.

Claude Code and Codex can also load Dvalin's **security-gate skill**. It tells
the agent to call Dvalin after security-sensitive edits (input handling, auth,
secrets, queries, commands, dependencies), to fix with the smallest change and a
regression test, never to suppress a finding, and not to call a fix done until
the verdict passes.
[Claude Code skill →](https://github.com/arthurpanhku/dvalincode/tree/main/integrations/claude-code#skill) ·
[Codex and Claude Code plugin →](https://github.com/arthurpanhku/dvalincode/tree/main/integrations/dvalin-security)

**On every pull request.** The GitHub Action needs no API key and no model:

```yaml
- uses: arthurpanhku/dvalincode@v0.24.0
  with:
    fail-on: high
    diff: true    # gate only what this pull request adds
```

Pass `fix-record:` and the runner re-derives the record and posts it beside the
diff; a record edited after it was issued fails there, and fails the job. Add
`reverify: true` and the runner re-executes the verification itself.

**In the terminal.** Let Dvalin drive the fixer until the gate would pass:

```sh
dvalincode dvalin . --until-clean --max-rounds 3 --executor codex
```

Each round, Dvalin re-scans, runs your checks, and sends the executor only what
is still wrong. The loop stops when the fix verifies, the round budget runs out,
or progress stalls. Every outcome issues a fix record.
[The CLI guide →](/cli)

## A real run

![Dvalin real scan and verified remediation](/dvalin-remediation.gif)

The real case shown above is adapted from OWASP NodeGoat. It moved from 10
findings and 22/F to 0 findings and 100/A after the three `eval` call sites were
replaced by a constrained numeric parser and an injection regression test was
added. The score is a triage heuristic, not certification.

## Two products: the CLI and the desktop app

The **[CLI](/cli)** is for terminals and automation, on macOS, Linux and
Windows: the `dvalin` security commands, CI gates, headless runs, and the MCP
server for the agents you already use. It also includes DvalinCode's
[built-in agent](/agent): run `dvalincode` bare for an interactive terminal
agent, or `dvalincode serve` to host the web GUI for browser and remote use.

The **[desktop app](/gui)** is the same engine in its own window, on macOS and
Windows: run the Dvalin security workspace, chat with the built-in agent, review
its diffs and approve each change, without a terminal.

![DvalinCode web GUI](/hero.png)

### Verification evidence at a glance

The Dvalin panel keeps the model review, project-check report, deterministic
re-scan, scanner coverage, security gate, and offline-record status together. A
clean score is only one piece of evidence: advisory gates, missing fix records,
and Git publication blockers remain visible beside it.

![DvalinCode verification evidence panel showing a real model review, a passing deterministic re-scan, complete four-engine coverage, an advisory gate, and explicit remaining caveats](/dvalin-verify-local.jpg)

## Trust and governance

A verdict is worth only as much as the runtime that issues it. An org policy
bounds what Dvalin may do, every run is hash-chained into a tamper-evident
audit log, and nothing reaches a model provider that the egress guard did not
allow. [Trust and governance →](/trust) · [Threat model →](/THREAT-MODEL)

## Code signing policy

Read the [Code signing policy](/CODE-SIGNING) and [privacy notice](/PRIVACY).
Free Windows signing through SignPath Foundation is being prepared; approval
and production signing have not been confirmed.

## Is Dvalin for you?

**Yes, if…**

- coding agents fix what your scanners report;
- you run more than one agent or scanner and want one verdict across them;
- you have to show an auditor that a repair worked;
- the verdict must be open, independent of any one AI vendor, and stay on your own machines.

**Probably not, if…**

- you want a coding agent — use Claude Code, Codex or opencode, then connect Dvalin;
- you want the widest vulnerability discovery — use a dedicated scanner or AI security agent;
- you run one scanner with its own platform autofix, and nobody asks for proof.
