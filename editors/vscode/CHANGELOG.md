# Changelog

All notable changes to the Dvalin Security Scan extension.

The version tracks the `dvalincode` CLI it is built against, so a given
extension version and CLI version always mean the same scanner.

## 0.17.0

First published release.

### Added

- `dvalin.scanScope`, defaulting to `changed`: a scan reads only the lines you
  have not committed yet, including new files. This is what makes
  `dvalin.scanOnSave` usable — a save reports what you just wrote instead of
  everything the repository already carried. Set it to `workspace` to read
  everything, or when the folder is not a git repository.

### Changed

- Findings are substantially quieter. The scanner no longer reports vendored
  third-party code, credentials in test fixtures, DOM teardown in a test
  harness, or risks that appear only inside comments, and it no longer reads a
  string that merely starts with a SQL verb as SQL injection.
- Added detection for a value interpolated into a MongoDB `$where`, which
  executes JavaScript on the database server.

## 0.15.0

Unpublished. Findings from the Dvalin scanner in the Problems panel, a
`Dvalin: Scan workspace` command, scan-on-save, and a governed fix-and-verify
action. No API key needed to scan.
