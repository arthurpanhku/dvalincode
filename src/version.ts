/**
 * Single source of truth for the DvalinCode version.
 *
 * Bump this on release (kept in step with package.json by the `release:` commit).
 * Everything that reports a version — the CLI `--version`, the trust report, and
 * the self-update check — imports from here so the copies can never drift.
 */
export const VERSION = '0.14.1';
