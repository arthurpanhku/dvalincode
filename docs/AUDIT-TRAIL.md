# Audit Trail

Every agent run (Cowork or Code) emits a **tamper-evident, hash-chained JSONL
log**. The Run Report — the Markdown summary you see in the CLI and GUI — is just
a rendering layer over that log. No local coding agent ships a verifiable record
of what the agent actually did; this is DvalinCode's flagship security
differentiator.

## Where logs live

One file per run:

```
~/.dvalincode/audit/run-<timestamp>-<id>.jsonl
```

Override the directory with the `DVALINCODE_AUDIT_DIR` environment variable
(used by the test suite to avoid touching your home directory).

## Event model

Each line is one JSON record: an event plus chain metadata
(`seq`, `ts`, `prevHash`).

| Event | Captures |
|-------|----------|
| `run_start` | task fingerprint/size, mode, provider, model, cwd, git HEAD |
| `provider_request` | provider/model, endpoint origin, outcome, status, duration |
| `tool_call` | tool name, minimized structural arg summary, `ok`/`error`, duration |
| `file_read` | path, content SHA-256 |
| `file_write` | path, `+added`/`−removed` lines, before/after content hash |
| `file_delete` | path, before hash |
| `shell_exec` | executable, exit code, sandbox (`seatbelt`/`bwrap`/`none`) |
| `approval` | tool, approved/rejected |
| `policy_violation` | blocked rule, tool, target (reserved for the Policy Engine, P0-2) |
| `run_end` | status, iterations, token usage, write warnings |

**Data policy:** task text, file contents, replacement text, memory contents, shell
arguments, prompts, provider headers, and provider bodies are never stored. Sensitive
inputs are represented by SHA-256 plus byte length. File paths and executable names
remain visible because they are required for an actionable run report.

## The hash chain

The chain anchors to the run id: `prevHash` of the genesis record is
`sha256(runId)`. Each record's hash is `sha256(canonicalJSON(record))`, where
`canonicalJSON` sorts object keys recursively so the digest is deterministic
across machines. The next record carries that hash as its `prevHash`.

Editing, inserting, deleting, or reordering any line breaks the chain at the
first record whose `prevHash` no longer matches — `report verify` reports the
exact `seq`.

## CLI

```
dvalincode report --last                 # render the most recent run
dvalincode report <run-id>               # render a specific run
dvalincode report <run-id> --format json # raw JSONL records
dvalincode report verify [<run-id>]      # validate the hash chain
```

`report verify` prints `✓ chain intact` (exit 0) or `✗ chain broken at seq N`
(exit 1).

## Threat model

**What the audit trail defends:**

- **Post-hoc forensics** — a reliable record of every file the agent read/wrote,
  every command it ran, and every approval decision, for after-the-fact review.
- **Behavior trace / accountability** — answers "what did the agent actually do
  this run?" with structure, not scrollback.
- **Accidental or in-band tampering detection** — any edit to the log that does
  not recompute the entire downstream chain is detected.

**What it does _not_ defend:**

- **A local root attacker.** The hash chain is tamper-**evident**, not
  tamper-**proof**. Anyone who can rewrite the file can recompute every hash from
  the genesis link and forge a consistent chain. The value is
  forensic/accountability, not cryptographic custody. We do not oversell this.
- **Content recovery.** Logs store hashes and line counts, not file contents — by
  design. Reconstructing exact past content from the log is not possible.

To raise the bar against a local attacker you would ship the chain head to an
append-only external sink (out of scope for v0.5).

## Mapping to agentic-AI risk (OWASP LLM Top 10)

The audit trail is the evidence layer that the enforced **Policy Engine** (P0-2)
builds on. Together they address:

- **Over-permissioned actions** — `policy_violation` events record every blocked
  operation; the policy layer enforces, the audit layer proves.
- **Prompt-injection-driven unauthorized writes** — every `file_write` /
  `file_delete` is logged with hashes, so an injection-driven change is visible
  after the fact even if it slipped through.
- **Sensitive-file exfiltration to the LLM** — `file_read` events make it
  auditable which files were fed to the model.
