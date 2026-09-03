# Dvalin security gate

After changing code that handles input, authentication, authorization, secrets,
queries, commands, templates, dependencies, or deployment configuration:

1. Call `dvalin_scan` with `scanners: ["builtin"]` at minimum.
2. Treat every result as evidence to validate, not as infallible truth.
3. If a reported issue will be repaired, call `dvalin_begin_verification` with
   the same arguments. This explicit state-changing step returns a workflow ID.
4. Call `dvalin_get_finding` with that workflow ID and fingerprint before
   editing. Read the relevant source and data flow.
5. Make the smallest behavior-preserving fix and add a focused regression test.
6. Run the project's focused checks.
7. Call `dvalin_verify_findings` with the workflow ID.
8. Report success only if the returned structured gate has `passed: true`.

Never claim that a clean scan proves the code is secure. Never suppress or
exclude a finding merely to make the gate pass. If an optional engine is absent,
report it; do not install software unless the user explicitly authorizes the
reviewed command.
