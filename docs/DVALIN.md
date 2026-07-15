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

## Scan → Fix → Verify → PR

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
