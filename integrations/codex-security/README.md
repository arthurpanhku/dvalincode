# Codex Security and Dvalin

Dvalin can interoperate with Codex Security, and it can also compete in the
security workflows where their capabilities overlap:

- **Codex Security** performs model-assisted threat modeling, deep discovery,
  validation, and focused remediation in its own security environment.
- **Dvalin** can perform its own deterministic and multi-engine discovery,
  orchestrate governed remediation, and independently verify the result. It can
  also accept Codex Security's portable findings as local remediation cases.

The integration described here is an interoperability path, not a claim of an
official partnership or endorsement. Neither product is required to run the
other. Codex Security access, credentials, execution, and sealed scan artifacts
remain governed by OpenAI's product and documentation.

## Handoff contract

The boundary is **SARIF 2.1**, not Codex Security's internal state directory.
OpenAI documents SARIF as the portable format for tools that support the SARIF
interchange standard. A completed scan can be exported with:

```sh
DVALIN_CODEX_SCAN_DIR=/tmp/codex-security-results
DVALIN_CODEX_SARIF=/tmp/codex-security.sarif

npx @openai/codex-security scan . \
  --output-dir "$DVALIN_CODEX_SCAN_DIR"

npx @openai/codex-security export "$DVALIN_CODEX_SCAN_DIR" \
  --export-format sarif \
  --source-root "$PWD" \
  --output "$DVALIN_CODEX_SARIF"
```

Running a Codex Security scan requires Codex Security access and its supported
authentication. Follow the current
[Codex Security documentation](https://learn.chatgpt.com/docs/security) rather
than copying credentials into project files.

## Import into Dvalin

Import the exported report against the matching workspace root:

```sh
dvalin import "$DVALIN_CODEX_SARIF" .
```

The command:

1. Parses the report without executing Codex Security or modifying its sealed
   scan bundle.
2. Rejects absolute result paths outside the selected workspace.
3. Normalizes source, rule, severity, location, tags, and source context.
4. Creates or updates stable local remediation cases under
   `~/.dvalincode/remediation/`.

Use `--json` for a versioned machine-readable import envelope. Use
`--no-persist` to validate a report without changing the remediation backlog:

```sh
dvalin import "$DVALIN_CODEX_SARIF" . --json --no-persist
```

## Use Dvalin from the same Codex workspace

Codex can also call Dvalin's deterministic gate over MCP while the Codex
Security plugin remains available for deep security work:

```sh
codex mcp add dvalin -- npx -y dvalincode mcp-serve --workspace .
```

This exposes `dvalin_scan`, `dvalin_get_finding`,
`dvalin_verify_findings`, and scanner/evidence tools to Codex. It does not make
Dvalin an internal Codex Security scanner and does not cause either product to
invoke the other automatically. The SARIF handoff remains the explicit boundary
between their security findings.

## Remediate and gate

An imported finding is external evidence, not a Dvalin pass or failure. Review
and validate it, then let Codex Security, DvalinCode, or another coding agent
prepare the smallest safe patch and its focused regression test. After applying
the accepted patch, run the project tests and the independent Dvalin gate:

```sh
npm test                         # use the repository's actual checks
dvalin scan . --fail-on high
```

Keep Codex Security's `scan-manifest.json`, `findings.json`, `coverage.json`,
and supporting artifacts together when they are part of the security evidence.
SARIF carries the finding projection; it does not preserve the complete coverage
or threat-model record. Dvalin therefore does not turn partial or unknown Codex
Security coverage into a complete result, and a clean Dvalin scan does not erase
an unresolved Codex Security finding.

Official references:

- [Export and track Codex Security findings](https://learn.chatgpt.com/docs/security/plugin/export-findings)
- [Run Codex Security in CI](https://learn.chatgpt.com/docs/security/cli/ci)
- [Codex Security TypeScript SDK](https://learn.chatgpt.com/docs/security/sdk)

For Dvalin's product boundary, competitive differentiation, current gaps, and
roadmap, see
[Security Agent Strategy](../../docs/SECURITY-AGENT-STRATEGY.md).
