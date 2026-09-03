---
name: dvalin-security-scan
description: Independently scan and verify code after security-sensitive edits, dependency changes, or an explicit security review request. Use Dvalin after modifying input handling, authentication, authorization, secrets, queries, commands, templates, dependencies, or deployment configuration. No model or API key is needed for scanning or verification.
---

# Dvalin security gate

Use the bundled `dvalin` MCP server when it is available. The server is bounded
to the current workspace and exposes deterministic scanning and verification
without trusting the model that wrote the code.

## After security-sensitive changes

1. Call `dvalin_scan` with `diff: "uncommitted"` and at least the `builtin`
   scanner. This preview is read-only and persists no Dvalin state. Run a
   workspace scan when the user asks for a full audit.
2. Read `coverage.status` before interpreting the findings. A zero-finding
   result with partial or unknown coverage is not a clean bill of health.
3. If a finding will be repaired, call `dvalin_begin_verification` with the same
   scan arguments. This is the explicit state-changing step and returns a
   workflow ID. Do not create a workflow merely to report scan results.
4. Call `dvalin_get_finding` with that workflow ID and the finding fingerprint,
   then inspect the surrounding source and data flow.
5. Make the smallest behavior-preserving change and add a focused regression
   test.
6. Call `dvalin_verify_findings` with the workflow ID. This re-scans
   and runs the repository's configured checks before issuing a Verified Fix
   Record.
7. Report success only when the returned gate passes. Include coverage,
   remaining findings, check outcomes, and the fix-record hash.

Use `dvalin_verify_fix` when the user provides an existing fix record. It
recomputes the record hash and verdict offline; it does not read the workspace
or use the network.

If MCP is unavailable, use the local fallback:

```sh
npx -y dvalincode security scan . --scanners builtin --json --no-workflow
```

Never describe a scan as proof that the code is vulnerability-free. Never
suppress a finding merely to pass the gate, and never install an optional
scanner unless the user explicitly authorizes its fixed install command.
