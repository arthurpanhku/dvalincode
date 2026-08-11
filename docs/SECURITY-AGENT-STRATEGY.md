# Security Agent Strategy

Dvalin follows one product principle: **cooperate where open boundaries improve
the user's workflow; compete where a better security outcome is possible**.

Codex Security is therefore neither a mandatory upstream dependency nor a
category Dvalin agrees to avoid. A user may run Dvalin alone, run both products
independently, or export portable findings from one workflow into another.
Interoperability and competition can coexist.

This document describes product direction, not an official partnership with or
endorsement by OpenAI.

## What we should learn

The public Codex Security workflow demonstrates several useful patterns:

- **Preflight before expensive work.** Validate targets, repository state, and
  runtime readiness before starting a model-assisted scan.
- **Two scan depths.** Keep a practical standard workflow and offer a bounded
  deep-discovery mode for cases that justify more time and model budget.
- **Explicit lifecycle and coverage.** Preserve whether a finding is new,
  persisting, reopened, resolved, dismissed, or unknown, and distinguish
  complete, partial, and unknown coverage.
- **Evidence that survives the UI.** Keep findings, coverage, manifests, proof
  gaps, and supporting artifacts portable and reviewable.
- **Programmable execution.** Expose typed targets, progress, cancellation,
  budgets, findings, coverage, and artifacts through a supported SDK and CI
  interface.

These patterns are documented in the official
[Codex Security overview](https://learn.chatgpt.com/docs/security),
[TypeScript SDK](https://learn.chatgpt.com/docs/security/sdk), and
[CI guidance](https://learn.chatgpt.com/docs/security/cli/ci). Learning from a
public workflow does not require copying private implementation details or
accepting another product's verdict as Dvalin's own.

## Where Dvalin competes

Dvalin's current and intended advantages are architectural rather than claims
about an unmeasured detection leaderboard:

- **Immediate local baseline.** Dvalin Built-in runs without an account, API
  key, model, or external security product. The same deterministic contract can
  run on a laptop, through MCP, or in CI.
- **Open scanner fleet.** Built-in rules, Semgrep CE, Trivy, OSV-Scanner, and
  SARIF evidence share one normalization, baseline, suppression, and gate
  contract. Additional engines remain replaceable.
- **Agent-neutral surface.** CLI, MCP, GitHub Action, structured JSON, and SARIF
  let human developers and different coding agents use the same security layer.
- **Local and governed operation.** Scanner installation is explicit, model use
  is optional, paths and execution are policy-bound, and publication remains an
  explicit step.
- **Independent evidence.** Baselines, reasoned suppressions, verification,
  hash-chained audit records, and release evidence are owned by the repository's
  security workflow rather than by the agent that wrote the patch.

These properties let Dvalin compete for the complete discover → triage → fix →
test → verify → publish workflow, not only for the final gate.

## Honest gaps today

The competitive position should be measured against current implementation,
not roadmap language:

- Dvalin Built-in is fast and dependable, but its rule coverage is narrower
  than a deep model-assisted security investigation.
- Dvalin has CLI, MCP, Action, and JSON contracts, but not yet a public typed
  security SDK.
- The persisted lifecycle distinguishes new, existing, and resolved cases, but
  does not yet express reopened, dismissed, or unknown states consistently.
- Imported SARIF is kept separate from Dvalin's own verdict, but Dvalin does not
  yet expose a complete/partial/unknown coverage contract for every scan.
- The remediation loop is governed and test-aware, but there is no dedicated
  bounded multi-worker deep-discovery mode yet.

## Competitive roadmap

### P0 — Trustworthy scan semantics

- Target and scanner preflight.
- Complete, partial, and unknown coverage with deferred areas preserved.
- Full finding lifecycle across local scans and imported evidence.
- Consistent progress, cancellation, budget, and evidence contracts.

### P1 — Deeper discovery and developer integration

- Standard and deep scan profiles with explicit budgets and stop conditions.
- Bounded parallel discovery workers that cannot bypass Dvalin policy.
- A public TypeScript SDK over the same contracts used by CLI, MCP, CI, and UI.
- First-class hooks for coding agents to request a finding, prepare a focused
  repair, add a regression test, and obtain an independent verification result.

### P2 — Evidence-based comparison

- Public benchmark fixtures covering true findings, false positives,
  remediation correctness, regression-test quality, latency, and cost.
- Reproducible comparisons against Codex Security and other security tools when
  licensing, access, and identical input conditions permit.
- A local workbench that explains coverage, proof gaps, scanner disagreement,
  case history, and why a gate passed or failed.

## Guardrails

- Do not claim an official OpenAI partnership without an explicit agreement.
- Do not read, mutate, or imitate Codex Security's sealed internal state; use
  documented portable exports such as SARIF.
- Do not turn another scanner's finding or coverage status into a Dvalin verdict
  without independent evidence.
- Do not publish superiority claims without reproducible inputs and scoring.
- Do not weaken Dvalin's deterministic no-model gate when adding deep discovery.
