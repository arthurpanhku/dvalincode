---
name: dvalin-security-scan
description: Scan code for injection, hardcoded secrets, XSS, dynamic code execution, and unsafe shell use. Use after writing or modifying code that handles user input, builds queries or commands, touches authentication, or adds a dependency — and whenever the user asks for a security check, audit, or review. Runs locally with no API key and no model.
---

# Dvalin security scan

A deterministic scanner. No model runs and it never edits the target workspace;
it persists only a compact local workflow so findings can be resumed and
independently verified.

## Running it

If a `dvalin` MCP server is configured, call `dvalin_scan`. Otherwise:

```sh
npx -y dvalincode security scan . --scanners builtin --json
```

Scan the whole workspace — the scanner takes a directory, not a file. `builtin`
needs nothing installed. Add `semgrep`, `trivy`, or `osv-scanner` only if they
are already on `PATH`; missing engines are reported, not fatal.

## Reading the result

```json
{ "score": 88, "grade": "B", "metrics": { "critical": 0, "high": 1 },
  "findings": [ { "ruleId": "dvalin/eval", "path": "app.js", "startLine": 3,
                  "securitySeverity": "7.5", "helpUri": "https://cwe.mitre.org/..." } ] }
```

Report findings by **file and line**, with the rule and why it matters. Cite
`helpUri` when the user may not know the vulnerability class. `securitySeverity`
is CVSS-shaped: ≥9 critical, ≥7 high, ≥4 medium.

## What to do next

Fix findings the way you would fix any other bug: read the surrounding code
first, then make the smallest change that removes the vulnerability class
rather than the symptom. Add a regression test that fails on the old code.
Re-run the scan to confirm.

If the user wants Dvalin itself to do the repair under policy, with tests and a
clean re-scan required before anything can become a PR:

```sh
dvalincode dvalin . --fix --verify --draft-pr
```

That command **does** use a model and edits files, so propose it rather than
running it unprompted.

## Honest limits

- A clean scan is not proof the code is safe. It finds known high-signal
  patterns; it does not find business-logic flaws, and it can produce false
  positives. Say so instead of declaring the code secure.
- Do not suppress a finding to make the scan pass. If something is genuinely a
  test fixture, exclude that path in `.dvalincodeignore` and say why.
- The score is a triage heuristic, not a certification. Lead with the findings,
  not the number.
