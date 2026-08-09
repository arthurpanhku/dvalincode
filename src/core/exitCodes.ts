/**
 * One exit-code convention for every command.
 *
 * These were previously per-command and disagreed with each other: a scan that
 * found problems exited 2, an Evidence Pack that failed verification exited 1,
 * and 2 also meant "bad flag" — so a CI step could not tell a real finding from
 * a typo. The codes below are the contract; `docs/HARNESS-MODE.md` carries the
 * table and `dvalincode --help` points at it.
 */
export const EXIT = {
  /** Completed, and the answer was yes. */
  ok: 0,
  /** The command tried to do its job and something went wrong. */
  runtimeError: 1,
  /** The invocation was wrong: bad flag, missing argument, unknown session. */
  usageError: 2,
  /** Org policy denied the mode, model, provider, tool, command, or path. */
  policyViolation: 3,
  /** Wall-clock timeout, SIGINT, or an aborted run. */
  interrupted: 4,
  /**
   * The command ran correctly and the answer was no — findings at or above
   * `--fail-on`, an Evidence Pack that did not verify. Distinct from 1 and 2 on
   * purpose: a gate result is not an error, and a pipeline needs to tell
   * "we found something" apart from "the tool broke" and "you typed it wrong".
   */
  gateNotMet: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Thrown for a bad argument *value* — a valid flag given something invalid.
 * Commander only maps its own parse failures to `usageError`; anything a
 * command validates itself used to surface as a runtime error, so
 * `--scanners nessus` and a crashed scanner were indistinguishable.
 */
export class UsageError extends Error {
  readonly exitCode = EXIT.usageError;
}
