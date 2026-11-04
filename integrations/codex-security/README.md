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

The preferred boundary is Codex Security's documented **completed, sealed scan
directory**, not its private application state. Dvalin reads only
`scan-manifest.json`, `findings.json`, and the referenced `coverage.json` when
present. It verifies the manifest-recorded SHA-256 hashes before accepting the
findings and never executes Codex Security during import.

Run a scan into an explicit directory outside the repository:

```sh
DVALIN_CODEX_SCAN_DIR=/tmp/codex-security-results
npx @openai/codex-security scan . \
  --output-dir "$DVALIN_CODEX_SCAN_DIR"
```

Running a Codex Security scan requires Codex Security access and its supported
authentication. Follow the current
[Codex Security documentation](https://learn.chatgpt.com/docs/security) rather
than copying credentials into project files.

## Import into Dvalin

Import the sealed directory against the matching workspace root:

```sh
dvalin import "$DVALIN_CODEX_SCAN_DIR" .
```

The command:

1. Requires `scan.status: completed` plus a seal timestamp.
2. Verifies the findings and coverage hashes recorded by the sealed manifest.
3. Rejects artifact traversal, symlinks, and finding locations outside the
   selected workspace.
4. Preserves Codex Security scan/finding/occurrence/fingerprint identity.
5. Carries exclusions, deferred work, follow-up surfaces, and open questions
   into an explicit `complete`, `partial`, or `unknown` coverage result.
6. Creates or updates stable local remediation cases under
   `~/.dvalincode/remediation/`.

Use `--json` for a versioned machine-readable import envelope. Use
`--no-persist` to validate a report without changing the remediation backlog:

```sh
dvalin import "$DVALIN_CODEX_SCAN_DIR" . --json --no-persist
```

SARIF 2.1 remains the compatibility path for older Codex Security versions or
pipelines that keep only exported interchange files:

```sh
DVALIN_CODEX_SARIF=/tmp/codex-security.sarif
npx @openai/codex-security export "$DVALIN_CODEX_SCAN_DIR" \
  --export-format sarif --source-root "$PWD" --output "$DVALIN_CODEX_SARIF"
dvalin import "$DVALIN_CODEX_SARIF" .
```

SARIF carries findings but not the full coverage contract, so a SARIF-only
handoff never becomes complete Codex Security coverage inside Dvalin.

## Use Dvalin from the same Codex workspace

Codex can also call Dvalin's deterministic gate over MCP while the Codex
Security plugin remains available for deep security work:

```sh
npx -y dvalincode mcp-install codex
```

This exposes the read-only `dvalin_scan`, the explicit state-changing
`dvalin_begin_verification`, `dvalin_get_finding`, `dvalin_verify_findings`, and
scanner/evidence tools to Codex. It does not make
Dvalin an internal Codex Security scanner and does not cause either product to
invoke the other automatically. Sealed portable artifacts remain the explicit
boundary between their security findings.

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
