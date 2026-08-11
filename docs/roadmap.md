# Roadmap

## 0.1 Foundation

- CLI shell
- Project scanner
- Tool registry
- Read tools
- Explicit execution permission
- Local task brief
- Tests and CI

## 0.2 Editing Workflow

- Add write-file and patch tools.
- Show a diff before applying changes.
- Add dry-run mode for write tools.
- Persist simple session records.

## 0.3 Provider Adapters

- Add a provider interface.
- Add one optional model adapter.
- Add structured tool-call planning.
- Add redaction hooks for sensitive files.

## 0.4 Extensions

- Add plugin manifest loading.
- Add project-local command packs.
- Add reusable workflow definitions.
- Add richer terminal rendering.

## 0.5 Security Differentiation

- **[done] Audit trail (P0-1):** tamper-evident hash-chained JSONL per run;
  `dvalincode report --last | <id> | verify`; GUI Run Report card. See
  [AUDIT-TRAIL.md](AUDIT-TRAIL.md).
- Enforced policy engine (P0-2): `dvalin.json` policies intercepted in the tool
  gating layer; `policy_violation` audit events; `THREAT-MODEL.md`.
- Checkpoint / rollback (P1-1): run-level snapshot + one-click rollback.

## 0.18 Security Ecosystem Interoperability and Competitive Depth

- **[done] Portable SARIF handoff:** `dvalin import <report> [workspace]`
  validates external paths and creates stable remediation cases.
- **[done] Codex Security integration:** consume the officially exported SARIF
  projection without reading or modifying the sealed scan bundle; retain its
  manifest, findings, and coverage as companion evidence.
- Add target preflight that validates repository state, supported scan scope,
  scanner readiness, and expected evidence before consuming model budget.
- Add an explicit coverage contract: complete, partial, or unknown, with
  deferred areas and open questions preserved as evidence rather than silently
  converted into a pass.
- Add a public TypeScript security SDK for preflight, scan/import progress,
  budgets, cancellation, structured findings, coverage, and gate results.
- Add explicit finding lifecycle states across scans: new, persisting,
  reopened, resolved, dismissed, and unknown when coverage is incomplete.
- Keep fast deterministic gates separate from optional deep agent-assisted
  discovery so CI never needs a model merely to enforce the baseline.
- Add standard and deep scan profiles. Deep scans may use bounded parallel
  workers, progress events, discovery budgets, and explicit stop conditions;
  standard scans retain the fast local contract.
- Publish reproducible benchmark fixtures for finding quality, false positives,
  remediation correctness, test preservation, latency, and cost. Compare with
  Codex Security and other tools only when the same public inputs and scoring
  method can be reproduced.
