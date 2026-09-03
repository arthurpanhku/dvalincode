# Changelog

All notable changes to the Dvalin Security Scan extension.

The version tracks the `dvalincode` CLI it is built against, so a given
extension version and CLI version always mean the same scanner.

## Unreleased

### Added

- Complete, partial, or unknown coverage is visible in notifications, the
  status bar, Problems related information, and the Dvalin Verification output
  channel together with gate and workflow evidence.
- `Dvalin: Verify Fix Record offline` re-derives a selected VFR without reading
  the workspace or using the network.
- When the CLI is not installed, a one-click setup can use the published npm
  package without silently downloading code on editor startup.

### Fixed

- Changed-scope scans now pass bare `--diff`, the CLI's documented form for
  uncommitted work. The previous literal `--diff uncommitted` was interpreted
  as a nonexistent git revision and made the default on-save scan fail.
- A zero-finding partial or legacy scan is described as clean only within its
  covered scope, never as complete assurance.

## 0.18.0

First published release. Versions before this one were built but never reached
a marketplace, so everything below is new to anyone installing it.

### Added

- Security findings from the Dvalin scanner in the Problems panel, on the lines
  that caused them. Scanning needs no API key, no model, and no account.
- `dvalin.scanScope`, defaulting to `changed`: a scan reads only the lines you
  have not committed yet, including new files. This is what makes
  `dvalin.scanOnSave` usable — a save reports what you just wrote instead of
  everything the repository already carried. Set it to `workspace` to read
  everything, or when the folder is not a git repository.
- A `Dvalin: Scan workspace` command, and a quick fix that runs the governed
  `--fix --verify` flow in a terminal where you can watch and interrupt it.
- Severity banded exactly as the CLI bands it, so the editor and a CI gate never
  disagree about what "high" means.

### Notes

Findings are substantially quieter than earlier internal builds. The scanner no
longer reports vendored third-party code, credentials in test fixtures, DOM
teardown in a test harness, or risks that appear only inside comments, and it no
longer reads a string that merely starts with a SQL verb as SQL injection. It
also gained detection for a value interpolated into a MongoDB `$where`, which
executes JavaScript on the database server.
