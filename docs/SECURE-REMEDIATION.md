# Secure Remediation

DvalinCode's remediation workflow starts with local findings. It can run a
lightweight local scan for common high-signal risks, and it can ingest SARIF
from GitHub Code Scanning, CodeQL, Semgrep, and other scanners that emit the
standard format.

The first implementation provides a local-first loop:

1. Run **Local scan** in Code mode, or import a `.sarif` / SARIF JSON report.
2. DvalinCode normalizes findings into rule, severity, location, tags, and
   source context. The local scan currently checks for hardcoded secrets, AWS
   key literals, SQL string concatenation, unsafe HTML sinks, dynamic code
   execution, and obvious shell command injection.
3. Create an isolated remediation worktree for a finding. DvalinCode generates
   a `dvalin/remediate/...` branch, creates the worktree under the local
   DvalinCode projects directory, and switches the GUI workspace to it.
4. Send the generated secure-remediation prompt into the current Code session.
5. The agent inspects the affected code, applies a minimal fix, runs relevant
   checks, and returns a PR-ready remediation report.

This is intentionally an assistant-mediated workflow rather than an automatic
background patcher. It keeps the repair auditable and lets users choose the
permission mode before code changes happen.

## Next Build Steps

- Persist imported findings as a local remediation case list.
- Add Semgrep CLI execution and SARIF import in one action.
- Add PR generation helpers that include the remediation report.
- Add policy controls for local-only models, approved cloud models, redaction,
  and per-run cost caps.
