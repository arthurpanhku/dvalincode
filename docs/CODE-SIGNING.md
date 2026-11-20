# Code signing policy

## Current status

DvalinCode is preparing an application for free Windows code signing through
[SignPath Foundation](https://signpath.org/). Acceptance and production signing
have not been confirmed. Existing Windows downloads must not be assumed to
carry a SignPath signature. Check each executable's Digital Signatures tab and
the release notes for its actual signing status.

If accepted and activated, the attribution for covered releases will be:

> Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This conditional attribution does not claim current sponsorship or approval.

## Project and signing scope

DvalinCode is [MIT-licensed](https://github.com/arthurpanhku/dvalincode/blob/main/LICENSE).
The requested scope is the project's own Windows CLI and desktop application
executables and desktop installer, built from the public source repository on
GitHub-hosted runners. Third-party scanner executables are not to be signed
using the project's signing policy. System components such as Microsoft
WebView2 retain their upstream distribution and signing arrangements.

The security workflow scans source code, dependencies, and development
artifacts and verifies repairs with tests and re-scans. It can generate and run
regression tests that reproduce a finding in the selected development
workspace. SignPath must review this functionality against its
[development/testing exception and other conditions](https://signpath.org/terms).

## Team responsibilities

| Role | Responsible maintainer |
| --- | --- |
| Committer / author | [arthurpanhku](https://github.com/arthurpanhku) |
| Reviewer of external contributions | [arthurpanhku](https://github.com/arthurpanhku) |
| Designated signing approver, pending service activation | [arthurpanhku](https://github.com/arthurpanhku) |

Repository review ownership is recorded in
[CODEOWNERS](https://github.com/arthurpanhku/dvalincode/blob/main/.github/CODEOWNERS).
External contributions require maintainer review before being included in a
signed release. Team members must use MFA for both repository and SignPath
access. SignPath access and signing policy configuration remain to be set up.

## Release controls

Before production signing is enabled, the release workflow must submit
GitHub-hosted build artifacts to SignPath and require an authorized maintainer
to approve every release's signing request. The executable payload must be
signed before packaging the installer; the installer must then be signed as
well. Signatures must be verified before final checksums, provenance, and
publication are generated. A release designated as signed must fail if signing
or verification fails.

Existing release workflows provide build, test, checksum, and provenance
steps; they do not yet implement the SignPath process described above.
Checksums and GitHub provenance attestations are distinct from Windows
Authenticode signatures. Signing also does not guarantee that SmartScreen
will immediately recognize a new release.

## Privacy and reporting

Read the [privacy notice](PRIVACY.md) for local storage, configured providers,
scanner services, web search, updates, and website analytics. The application
is not unconditionally offline: network use depends on the selected features
and configuration.

Report release-integrity concerns through the
[security policy](https://github.com/arthurpanhku/dvalincode/security/policy).
