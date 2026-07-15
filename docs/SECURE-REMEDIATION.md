# Secure Remediation

Secure remediation now lives in the dedicated **Dvalin** workspace. It starts
from scanner evidence, validates that evidence against source and data flow,
applies the smallest safe fix, and records test plus re-scan evidence before a
branch is published.

## Workflow

1. Select a project and run the Dvalin scanner suite, or import a SARIF 2.1
   report from CodeQL, GitHub Code Scanning, Semgrep, or another compatible
   scanner.
2. Dvalin normalizes findings into rule, severity, location, tags, source
   context, and stable remediation cases under `~/.dvalincode/remediation/`.
3. Review and select candidates. Findings remain hypotheses until the agent
   confirms the affected source and reachable data flow.
4. Fix selected findings in the active branch or create an isolated
   `dvalin/remediate/...` git worktree for a single case.
5. Run focused tests, then the relevant typecheck/build checks, and re-run the
   scanner suite. Scanner suppression or weakened tests are not accepted as a
   remediation.
6. Review the diff and remaining risk. Only the explicit **Create draft PR**
   action authorizes branch creation, commit, push, and a draft PR/MR. Dvalin
   never merges it automatically.

See [DVALIN.md](DVALIN.md) for scanner installation, policy behavior, scoring,
and operational boundaries.
