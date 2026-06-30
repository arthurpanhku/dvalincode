# Security Policy

DvalinCode is early-stage software for local developer workflows.

## Reporting

Please open a GitHub issue for non-sensitive security concerns.

For sensitive issues, contact the repository owner privately through GitHub.

## Security Expectations

- Tools must validate input before execution.
- File access should remain inside the active workspace.
- Process execution must require explicit permission.
- Future provider adapters should treat model output as untrusted input.
- GitHub Actions must use least-privilege `permissions` and pinned action SHAs.
- Security-sensitive pull requests should document their approval, audit, privacy,
  and model/provider impact.

## Supply Chain Baseline

DvalinCode maintains an OpenSSF Scorecard workflow, CodeQL analysis, Dependabot
updates, CODEOWNERS review routing, and SHA-pinned GitHub Actions. See
[docs/security/OPENSSF-SCORECARD.md](docs/security/OPENSSF-SCORECARD.md) for
the current control map and the GitHub repository settings that must be enabled
outside the git tree.

## AI Governance Baseline

AI governance evidence is tracked under `docs/governance/`, including ISO/IEC
42001 AIMS alignment and an AI change impact assessment template. These
documents are project governance artifacts; they do not claim third-party ISO
certification.

## Audit Trail

Every agent run emits a tamper-evident, hash-chained JSONL log under
`~/.dvalincode/audit/`. It is **tamper-evident, not tamper-proof**: its value is
post-hoc forensics and accountability, not cryptographic custody against a local
root attacker. See [docs/AUDIT-TRAIL.md](docs/AUDIT-TRAIL.md) for the format and
full threat model. Verify a run's chain with `dvalincode report verify <run-id>`.
