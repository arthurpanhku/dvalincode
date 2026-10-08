# Security Agent Strategy

Dvalin follows one product principle: **cooperate where open boundaries improve
the user's workflow; compete where a better security outcome is possible**.

Codex Security is therefore neither a mandatory upstream dependency nor a
category Dvalin agrees to avoid. A user may run Dvalin alone, run both products
independently, or export portable findings from one workflow into another.
Interoperability and competition can coexist.

This document describes product direction, not an official partnership with or
endorsement by OpenAI.

## Positioning: the referee of the remediation loop

The pain this product exists for is concrete. A CI scanner — Snyk, Semgrep,
CodeQL, Trivy — blocks a change. The finding is handed to a coding agent. The
agent's patch is pushed, and the scanner blocks it again: the target is still
there, or the patch introduced something new, or the branch has drifted and
the rebase brought a finding back. A person relays scanner output to the agent
and rebases by hand, round after round.

Dvalin's position in that loop is **controller and referee, not fixer**:

| | Dvalin | Coding agent (Claude Code, Codex, Copilot, ours, a person) |
|---|---|---|
| Goal | Defines and locks it: which findings must close, the gate threshold, no new suppressions | Cannot see or change it |
| Detection | Runs the same scanners the CI gate runs, normalized into one contract | Receives only the delta |
| Fix | — | Edits code; writes the regression test |
| Each round | Re-scans, runs the checks, checks for evasion | — |
| Feedback | The precise delta: what remains, what was introduced, which check failed, what was judged evasion | Fixes the next round from it |
| Stop | Goal met; budget spent; no progress; judged not auto-fixable | — |
| Output | A signed fix record, or a diagnosis of where it got stuck | — |

The invariant that makes the loop trustworthy: **the fixer never touches the
referee** — not the rules, not the suppression policy, not the checks, not the
signing key. `reverify` already judges a change under its base commit's
policy and keeps the signing key out of the checks' environment; the loop
extends that to every round.

### Why the referee, not the fixer

Fixing is the commodity half. General-purpose coding agents improve on their
own schedule, and the scanner vendors already ship their own autofix (Snyk
Agent Fix, Copilot Autofix with CodeQL, Codex Security). Competing on patch
quality is competing with all of them inside their own platforms.

The hard half is the one nobody selling a fix can credibly own: deciding
*whether the fix is real*. A vendor whose fix is judged by its own scanner is
grading its own work. Dvalin's ground is neutrality — across scanners, across
agents, with a referee independent of both — and evidence an auditor can
re-check. That matters most to teams running more than one scanner or agent,
and to regulated teams that must show a repair worked. A team on a single
scanner and a single platform autofix may reasonably not need it.

### The central risk: a loop that rewards silence

Looping "until the scanner is clean" optimizes for the scanner going quiet,
not for the vulnerability going away, and more rounds mean more pressure. The
evasions are predictable:

- adding an ignore entry (`.snyk`, `.semgrepignore`, `.trivyignore`) or an
  inline marker (`// deepcode ignore`, `nosemgrep`, `nosec`);
- rewriting the sink into a form the rule does not match (`eval(x)` →
  `new Function(x)()`);
- deleting or disabling the functionality;
- passing on tests too weak to notice.

So "real fix" is judged in three layers, and only the first is a scan:

1. **Scan** — targets gone, nothing introduced at or above the gate, coverage
   complete, all under the base commit's rules. *(shipped)*
2. **Evasion** — suppressions added by the change are not honored when judging
   the change; same-family sink rewrites, deleting the vulnerable file,
   deleting tests, and removing assertions are open problems the loop will not
   call fixed. *(shipped; untested changed lines: planned)*
3. **Reproduction** — for code findings, the agent first writes a security
   test that **fails on base and passes after the fix**, and Dvalin runs it on
   both sides itself. This is a stronger oracle than "the scanner stopped
   reporting it", and the same principle as `reverify`: trust what was
   observed, not what was claimed. A finding no test could demonstrate stops
   the loop as `not-reproduced` and goes to a person, before anything is
   fixed. *(shipped, locally and re-executed in CI `reverify`)*

Dependency vulnerabilities are the opposite case: "upgrade to a safe version
and the checks still pass" is close to deterministic, which makes them the
first class to automate. What needs handling there is the absence of an
upgrade path and upgrades that break the build — both are stop conditions,
not reasons to keep looping.

### Loop roadmap

1. **Same yardstick as CI.** Snyk Code and Snyk Open Source as engines in the
   suite, so the loop, the verifier, and the CI gate measure with the same
   scanner; suppressions added by the change under review are neutralized when
   it is judged. *(shipped)*
2. **Bounded fix loop.** `dvalincode dvalin --fix --until-clean --max-rounds N`:
   delta-only feedback to the executor, stop on success, budget, no progress,
   or not-auto-fixable. Dependency findings first. *(shipped; every round is
   logged)*
3. **Reproduce-then-fix** for code findings, plus evasion evidence.
   *(shipped)*
4. **Rebase inside the loop**, re-verified after every rebase, closed by a
   signed `reverify` record in CI. *(shipped: `--rebase-onto`, conflicts-only
   prompts, baseline re-scanned on each new base; the draft PR carries
   `.dvalin/fix-record.json`, and CI `reverify` re-runs the reproduction with
   the fix reverted in place — see `docs/examples/dvalin-fix-loop.yml`)*

Every round is recorded from the first release — rounds to green, where loops
stall, how often a patch was judged evasion — because that data both tunes
the loop and is the adoption evidence this project currently lacks.

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
- The fix loop iterates, reproduces, rejects common evasions and rebases, but
  the agent half runs from the CLI or an agent job, not as a GitHub Action
  input; CI's part is to re-execute and sign what the loop produced.
- None of this has been measured against real agents on real repositories
  yet. The round logs exist so that it can be.
- A reproduction proves a test written before the fix failed on the vulnerable
  code and passes after it, unchanged — not that the test exercises the
  vulnerability rather than something adjacent.
- Evasion detection is pattern-based: a sink family not listed, or logic
  deleted inside a file that survives, is not caught.
- CodeQL is not an engine of the suite yet, so for teams gated on it a Dvalin
  "verified" can still disagree with the gate that blocks the merge.

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
- Never let the executor configure, select, or suppress what judges it: rules,
  suppressions, checks, and signing keys come from outside the change.
- Never count a suppression as a fix, and never present "the scanner stopped
  reporting it" as "the vulnerability is gone".
- Do not compete on patch generation; delegate it, and compete on the verdict.
