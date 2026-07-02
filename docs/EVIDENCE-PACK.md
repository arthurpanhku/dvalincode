# Evidence Pack v1 Design

## Why

DvalinCode's North Star is being **trivially approvable by a security review**.
The controls already exist — resolved org policy, per-boundary egress
enforcement, a tamper-evident hash-chained audit trail — but today a reviewer has
to gather that evidence by hand and take the mapping to their compliance
framework on faith.

The Evidence Pack turns claims into a **single, portable, offline-verifiable
artifact**: "here is my policy, here is what my runs actually did, here is the
proof none of it was altered, and here is how each control maps to OpenSSF /
ISO-42001." Evidence over assertions. This is the highest-leverage step toward
the North Star, and it is pure aggregation of primitives that already exist —
no new trust surface.

## Command surface

```
dvalincode evidence export [--out <file>] [--run <id>...] [--last <n>] [--cwd <dir>]
dvalincode evidence verify <file>
```

- `export` writes one JSON file (default `dvalincode-evidence-<timestamp>.json`).
  With no run selector it includes the most recent `--last 10` runs.
- `verify` re-derives every hash in the file and re-runs the audit-chain check on
  each embedded run — **fully offline**, reading nothing but the file itself.

## Bundle contents

A single JSON document:

| Section | Source | Purpose |
|---|---|---|
| `schema` / `generatedAt` / `tool` | constant / `Date` / version | provenance of the pack |
| `policy` | `loadPolicy(cwd)` → resolved policy, sources (+ file hashes), canonical hash | **controllable** — the exact rules in force |
| `trust` | `buildTrustReport(cwd)` | **transparent** — the live enforcement posture (network, sandbox, MCP surface) |
| `runs[]` | per run: `meta` (run_start fields), `records` (the audit chain), `verify` (`verifyRecords`), `journalAnchor?` | **auditable** — what each run did + proof the chain is intact |
| `compliance` | static control→clause map, each marked backed/unbacked by this pack | reviewer's bridge to OpenSSF Baseline / ISO-42001 |
| `manifest` | per-section SHA-256 + top-level `bundleHash` | the pack is itself tamper-evident |

## Integrity model

- Each section is hashed with `sha256(canonicalJSON(section))` — canonical JSON
  makes the hash independent of key order.
- `manifest.bundleHash = sha256(canonicalJSON(pack-without-bundleHash))`. Changing
  any byte of meaning changes the bundle hash.
- Each embedded run additionally carries its own `verify` result, and `verify`
  re-computes it from the embedded `records` via `verifyRecords(runId, records)` —
  so a reviewer can confirm the chain independently of our say-so, and detect if
  records were edited/inserted/removed/reordered after export.
- Two layers on purpose: the bundle hash proves *the pack* wasn't altered; the
  per-run chain proves *each run log* wasn't altered before it went in.

## Data minimization

The pack inherits the audit trail's minimization — it copies already-minimized
records, never re-derives from raw material. Concretely it contains **no**
prompts, file contents, shell arguments, API keys, or MCP auth headers, because
those never entered the audit records in the first place (see
EGRESS-THREAT-MODEL.md → Audit Data Policy). Policy files and the trust report
carry no secrets. `verify` asserts this invariant structurally.

## Acceptance matrix

| Case | Expected |
|---|---|
| `export` with no runs present | Valid pack with `runs: []`, policy + trust + manifest still present |
| `export --last 3` | Newest 3 runs embedded, each with a passing `verify` |
| `verify` on an unmodified pack | `ok: true`; every section hash matches; every run chain intact |
| Any byte of a section changed | `verify` reports the section whose hash no longer matches |
| A record edited/removed inside an embedded run | that run's chain `verify` fails at the broken seq; bundle hash also changes |
| Pack contents | No prompt, file content, shell argument, API key, or auth header anywhere |
| `verify` | Reads only the file — no network, no `~/.dvalincode` access |

## Non-goals (v1)

- Cryptographic **signing** (device/GPG attestation) — v1 is tamper-*evident*
  via hashes, matching the audit trail's own posture; signing is a later add-on.
- Bundling source, SBOM, or CI attestations — those live in the repo/release
  supply chain, not a per-install runtime pack.
- A rendered PDF/HTML report — v1 emits machine-verifiable JSON; a renderer can
  consume it later.
- Proving controls the running install does **not** exercise (the compliance map
  marks a clause "unbacked" rather than fabricating evidence).
