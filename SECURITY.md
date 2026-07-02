# Security Policy

DvalinCode is early-stage software for local developer workflows. Security
reports are welcome, especially findings that affect file access, shell
execution, provider egress, audit logs, release artifacts, or AI permission
boundaries.

## Supported Versions

Only the latest release and the `main` branch receive security fixes. Older
release lines may be patched when a maintainer decides the issue materially
affects active users.

## Reporting a Vulnerability

For sensitive vulnerabilities, please use GitHub private vulnerability
reporting:

https://github.com/arthurpanhku/dvalincode/security/advisories/new

If private vulnerability reporting is unavailable, contact the repository owner
privately through GitHub. Please do not open a public issue for exploitable
security vulnerabilities until a maintainer has had time to triage and prepare a
fix.

For non-sensitive hardening requests or documentation issues, open a public
issue:

https://github.com/arthurpanhku/dvalincode/issues/new

Useful report details include:

- Affected version, commit, platform, and install method.
- Reproduction steps or a minimal proof of concept.
- Impact, affected files, commands, provider requests, or release artifacts.
- Whether the issue exposes user data, secrets, local files, audit logs, or
  model/provider traffic.

## Response Timeline

- Initial acknowledgement target: 3 business days.
- Initial triage target: 7 business days.
- Fix target: as soon as practical based on severity, exploitability, and
  release risk.
- Public disclosure: after a fix is available, or earlier when coordinated with
  the reporter and maintainers.

Maintainers may use GitHub Security Advisories for coordinated disclosure,
credit, CVE request, and private patch review when appropriate.

## Scope

In scope:

- Unauthorized file read/write/delete or workspace boundary bypass.
- Unsafe shell execution, command approval bypass, or sandbox bypass.
- Provider egress bypass, API key exposure, or secret leakage.
- Audit log tampering, missing security-relevant audit events, or misleading run
  reports.
- Release, installer, dependency, or GitHub Actions supply-chain issues.
- Prompt-injection paths that escalate tool permissions or bypass policy.

Out of scope:

- Social engineering, phishing, or attacks against third-party model providers.
- Issues requiring physical access to an already-compromised machine.
- Denial-of-service findings without a practical security impact.
- Reports that depend on intentionally disabling documented safety controls.
- The explicitly documented enforcement exemptions and non-goals in
  [docs/EGRESS-THREAT-MODEL.md](docs/EGRESS-THREAT-MODEL.md) (e.g. the local git
  calls in `remediation/worktree.ts`), unless you can demonstrate a practical
  escalation through them.

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
