# OpenSSF Scorecard Support

DvalinCode uses OpenSSF Scorecard as a supply-chain security signal for the
repository. The workflow is implemented in `.github/workflows/scorecard.yml`
and publishes SARIF so findings can appear in GitHub code scanning.

This document is the operating map for keeping the score meaningful. It is not a
promise of a perfect score, because some checks depend on GitHub repository
settings outside the git tree.

## References

- OpenSSF Scorecard: https://github.com/ossf/scorecard
- Scorecard GitHub Action: https://github.com/ossf/scorecard-action
- Scorecard results viewer: https://scorecard.dev/viewer/

## Implemented Controls

| Scorecard area | DvalinCode control | Evidence |
|---|---|---|
| Security-Policy | Public vulnerability reporting policy | `SECURITY.md` |
| License | MIT license | `LICENSE` |
| CI-Tests | CI runs type-check and tests | `.github/workflows/ci.yml` |
| SAST | CodeQL analysis for JavaScript/TypeScript | `.github/workflows/codeql.yml` |
| Token-Permissions | Workflows declare least-privilege permissions | `.github/workflows/*.yml` |
| Pinned-Dependencies | GitHub Actions are pinned to commit SHAs | `.github/workflows/*.yml` |
| Dependency-Update-Tool | Dependabot for npm and GitHub Actions | `.github/dependabot.yml` |
| Code-Review | CODEOWNERS and PR governance checklist | `.github/CODEOWNERS`, `.github/PULL_REQUEST_TEMPLATE.md` |
| Packaging | Release workflow verifies checksums and uploads release assets | `.github/workflows/release.yml` |

## Required GitHub Repository Settings

These controls cannot be fully represented in git. Enable them in GitHub
repository settings:

1. Branch protection or repository ruleset for `main`.
2. Require pull request review before merging.
3. Require CI and CodeQL checks to pass before merging.
4. Dismiss stale approvals when new commits are pushed.
5. Require CODEOWNERS review for protected paths.
6. Enable Dependency graph and Dependabot alerts.
7. Enable secret scanning and push protection when available.
8. Enable private vulnerability reporting or GitHub security advisories.

## Operating Procedure

1. Scorecard runs on pushes to `main`, weekly, when branch protection changes,
   and on manual dispatch.
2. Review SARIF findings in GitHub code scanning.
3. Treat new high-severity findings as release blockers unless a maintainer
   records a documented exception.
4. Keep action SHAs pinned. Dependabot should open updates; maintainers should
   verify the upstream release notes before merging.
5. Do not relax workflow permissions without recording the reason in the pull
   request.

## Local Triage Commands

```sh
gh workflow run scorecard.yml
gh run list --workflow scorecard.yml --limit 5
gh run view --log
```

To inspect the public score after the first run is indexed, open:

```text
https://scorecard.dev/viewer/?uri=github.com/arthurpanhku/dvalincode
```

## Known Gaps

- Branch protection, security advisories, dependency graph, Dependabot alerts,
  and secret scanning are GitHub settings and must be verified by a repository
  administrator.
- OpenSSF Scorecard is a signal, not a certification. Use it alongside code
  review, release verification, and the AI governance evidence in
  `docs/governance/`.
