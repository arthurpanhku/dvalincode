# Dvalin Security Workspace

Dvalin is DvalinCode's white-box security engineering workspace. It combines
scanner orchestration, SARIF normalization, source-aware triage, isolated
remediation, test verification, and explicit draft-PR publication in one flow.

## Scanner Fleet

The built-in engine is always available and checks high-signal patterns such as
hardcoded secrets, AWS keys, SQL concatenation, unsafe HTML sinks, dynamic code
execution, and shell injection. Dvalin also detects these optional open-source
CLIs from `PATH`:

| Engine | Coverage | Install example |
|---|---|---|
| Semgrep Community Edition | Multi-language semantic SAST | `python3 -m pip install semgrep` |
| Trivy | Dependency vulnerabilities, secrets, and IaC misconfiguration | `brew install trivy` |
| OSV-Scanner | Open-source dependency vulnerability matching | `brew install osv-scanner` |

Each external engine emits SARIF 2.1. Dvalin normalizes and de-duplicates the
reports, rejects absolute result paths outside the selected workspace, and
persists findings as local remediation cases. Missing optional engines are
shown as `missing`; they do not prevent installed engines from completing.

## CLI

Run the same scanner suite without opening the GUI:

```bash
dvalincode dvalin .
dvalincode dvalin . --scanners builtin --limit 10
dvalincode dvalin . --json
dvalincode dvalin . --sarif dvalin.sarif
dvalincode dvalin . --fail-on high
dvalincode dvalin . --diff
dvalincode dvalin . --diff origin/main...HEAD
dvalincode dvalin . --staged
dvalincode dvalin . --scanners builtin --fix
dvalincode dvalin . --fix --verify
dvalincode dvalin . --fix --verify --draft-pr
```

The default run detects all four engines and reports optional scanners that are
not installed. `--fail-on` is opt-in so interactive scans remain informational;
in CI it exits **5** when a finding at or above the selected severity is present.

5 means "the gate did not pass", not "the command failed" — a bad flag still
exits 2 and a scanner crash still exits 1, so a pipeline can tell a real finding
apart from a typo. See the table in
[HARNESS-MODE.md](HARNESS-MODE.md#exit-codes). This changed in 0.17.0; it was
previously 2, which collided with usage errors.

### Who verifies a fix

`--fix` asks an agent to edit code. It does not ask that agent whether its own
edit works, because that is the one question it cannot answer against interest.
Dvalin runs the project's checks itself — `test`, `typecheck`, and `build`,
detected the same way the `run_check` tool detects them — and the verification
gate weighs the exit codes it observed, not a report it was given.

Use `--verify-command` when a project's checks cannot be detected. It is
repeatable, and it is argv rather than a shell line, so a chained command is an
argument and not a second command:

```bash
dvalincode dvalin . --fix --verify --verify-command "cargo test" --verify-command "cargo clippy -- -D warnings"
```

A project that defines no checks at all fails the gate rather than passing by
default: an unverifiable fix is not a verified one.

`--executor` selects who does the editing — `dvalin` (the built-in agent) or
`codex` (OpenAI's harness through `codex exec`). Because verification never
consults the executor, that choice is about cost and quality, not trust.

### Scanning only what changed

`--diff` narrows the report to lines that changed, so a scan answers "did this
edit introduce anything?" rather than "what is wrong with this repository?".
That is the question worth asking after an agent writes code, and it is the
only form that stays quiet enough to run on every save.

`--diff` with no value compares the working tree against `HEAD` and treats
untracked files as new in full — an agent's brand-new file is entirely in scope.
`--diff <ref>` takes any revision or range, such as `origin/main...HEAD` for a
pull request. `--staged` reads the index instead.

A scoped run reports a finding count rather than a health grade: a score
computed from a forty-line diff would not describe the repository, and pretending
otherwise is how a number stops meaning anything. The `--fail-on` gate still
applies, so CI can block a pull request that *adds* a high-severity finding while
ignoring pre-existing ones.

Scoping is read-only. It cannot be combined with `--fix`, `--verify`, or
`--draft-pr`, because a repair may touch lines the diff never named and
verifying it has to look wider than the scan did.

`--sarif <file>` additionally writes the result as SARIF 2.1.0, with
`security-severity` on each rule and a stable fingerprint per finding so an
unchanged finding is not re-alerted on every run. It composes with `--json` and
with `--fix`, in which case it reflects the post-remediation state rather than
the baseline.

### Import external security evidence

Codex Security and other compatible security tools can hand findings to Dvalin
through SARIF 2.1 without becoming part of the trusted Dvalin scanner process:

```bash
dvalin import /path/to/codex-security.sarif .
dvalin import /path/to/codex-security.sarif . --json --no-persist
```

The first form creates or updates stable local remediation cases. The second
only validates and normalizes the report. Imported findings remain external
evidence: they do not pass the Dvalin gate, do not modify the source tool's
sealed artifacts, and do not transfer that tool's coverage assessment. See the
[Codex Security integration guide](https://github.com/arthurpanhku/dvalincode/tree/main/integrations/codex-security).

## GitHub Action

The repository publishes itself as a composite action, so a scan needs nothing
installed and no secrets:

```yaml
permissions:
  contents: read
  security-events: write   # to publish findings to code scanning
  pull-requests: write     # only when comment: 'true'
steps:
  - uses: actions/checkout@v5
  - uses: arthurpanhku/dvalincode@v0.17.0
    with:
      fail-on: high        # critical | high | medium | low | none
      scanners: builtin    # add semgrep,trivy,osv-scanner if on PATH
      comment: 'true'      # sticky PR comment, updated in place
```

The action uploads SARIF to code scanning, writes a job summary, and applies the
severity gate *after* both — so a failing gate still leaves the findings visible.
Inputs and outputs are documented in [`action.yml`](../action.yml); a complete
workflow is in [`examples/dvalin-scan.yml`](examples/dvalin-scan.yml).

Only `builtin` runs with no extra setup. The external engines are used when they
are already on `PATH`, and are reported as `missing` rather than failing the run
when they are not.

`--fix` validates and remediates up to 20 findings in an isolated git worktree
by default (`--max-fixes` changes the cap; `--in-place` is an explicit opt-in).
`--verify` adds focused tests plus an independent scanner re-run. `--draft-pr`
implies both phases and is rejected with `--in-place`; a draft can be published
only when the agent reports tests passing, the worktree has an actual diff, the
original finding targets disappear, and no new high/critical target appears.

## Scan → Fix → Verify → PR

In the GUI, the remediation conversation remains the central workspace. Current
scanner coverage, health, findings, and workflow actions live in a collapsible
right-side status panel; the left sidebar remains navigation and run history.

- **Scan:** select engines, run the suite, inspect per-engine status, and use
  the risk grade to prioritize triage. Imported SARIF follows the same case
  workflow.
- **Fix:** validate each finding against source before editing. Use a minimal
  patch in the current workspace or a dedicated remediation worktree.
- **Verify:** run focused tests, project checks, and a fresh Dvalin scan; inspect
  the diff for test weakening, suppressions, secrets, and unrelated edits.
- **PR:** an explicit user click asks the agent to re-check evidence, create a
  focused branch and commit, push, and open a **draft** PR/MR. It never merges.

## Policy and Network Behavior

Scanner commands pass through the same org command policy as other governed
processes. A deny rule or default-deny policy can block an engine. Semgrep,
Trivy, and OSV-Scanner may need network access to download rules or vulnerability
databases; `network: off` or `endpoint-only` can prevent that access. Use cached
databases or only the built-in scanner for an offline workflow.

The dashboard score is a deterministic triage heuristic based on finding
severity. It is not a compliance certification and a clean result is not proof
that the codebase is vulnerability-free. Scanner findings can be false positives
or omit business-logic flaws, so source validation and human review remain part
of the workflow.

## Agent Tool

`run_security_suite` is available to Code and Dvalin agents. It accepts an
optional `scanners` list (`builtin`, `semgrep`, `trivy`, `osv-scanner`), returns
per-engine status and normalized metrics, and persists remediation cases by
default. Organization policy can deny the tool or its underlying commands.
