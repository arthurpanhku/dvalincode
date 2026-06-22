# Approvability Plan — make DvalinCode trivially approvable by any company

> **North Star:** make it trivial for *any* company to approve adoption of DvalinCode.
> The coding agent is the wedge; **approvability is the product.**

This document derives the requirements from first principles, states the assumptions
made (so they can be overridden), and lays out a phased development plan with concrete
acceptance criteria tied to this codebase.

---

## 1. First principles

### 1.1 What "approval" actually is

A tool gets approved when a **gatekeeper** (security / IT / compliance / procurement)
makes a risk decision. Strip it down:

> **Approval happens when a gatekeeper reaches sufficient confidence, at low enough
> effort, that residual risk is bounded and controllable — and can defend that
> decision later.**

Modeled as a relation, a "yes" requires all four:

```
approval  ⟸  Risk ≤ tolerance          (containable)
          ∧  Confidence is high          (believable)
          ∧  Effort to verify is low     (cheap)
          ∧  Decision is defensible       (accountable)
```

Plus one meta-condition that kills deals for small vendors:

```
          ∧  approval does not depend on trusting the vendor's survival
```

### 1.2 The three core principles: 可控 · 透明 · 可审计

The whole North Star reduces to three irreducible principles. They are not arbitrary —
they are the **complete** coverage of an agent's behavior across time, and each maps to a
question the security gatekeeper actually asks:

| Principle | Time phase | Gatekeeper's question | Mandate |
|---|---|---|---|
| **可控 / Controllable** | ex-ante (before) | "What *can* it do, and who sets the bounds?" | Blast radius is bounded by something the **company** controls, not the developer. |
| **透明 / Transparent** | in-flight (during) | "What *is* it, and what is it *doing* — can I see?" | What the tool is and what it does is inspectable by the gatekeeper, not taken on trust. |
| **可审计 / Auditable** | ex-post (after) | "What *did* it do — can I *prove* it?" | Every action leaves a tamper-evident record, verifiable after the fact. |

Two properties make this set exactly right — sufficient and necessary:

- **Completeness.** An agent's behavior has only three tenses: what it *can* do, what it
  *is* doing, what it *did*. These three principles saturate all three. There is no
  fourth axis to leak through.
- **Mutual dependence.** None stands alone: controllable-but-not-auditable = unverifiable
  promises; auditable-but-not-transparent = a black-box log nobody can interpret;
  transparent-but-not-controllable = watching helplessly without the ability to stop it.
  **Approval requires all three present at once.** This is precisely where cloud,
  closed, mutable-log incumbents structurally cannot follow.

### 1.2.1 Mechanisms (the five pillars, subordinate to the three principles)

Each principle is delivered by concrete mechanisms:

| Principle | Mechanisms (pillars) | One-line mandate |
|---|---|---|
| **可控** | **Containment** | Bound the blast radius; the company writes the policy. |
| **透明** | **Verifiability** + **Evidence-as-a-product** + **Continuity** | Open source / small binary, SBOM, `trust` self-report, source + self-host. |
| **可审计** | **Accountability** | Hash-chained tamper-evident log mapped to named compliance controls. |

Everything below is an instance of one of the three principles. If a proposed feature
isn't, it's out of scope for this North Star.

### 1.2.2 Non-negotiable constraint: UX parity with mainstream coding agents

Governance products most often fail by becoming a **compliance burden** — heavier and
more bureaucratic than the familiar agents — which kills developer adoption. And
developer adoption is what puts the tool in front of the approver in the first place.
So everything below is bound by one hard constraint:

> **Day-to-day UX must stay as easy as Codex CLI / Claude Code / OpenCode.**
> Governance is *additive and opt-in*, never in the hot path.

Concrete rules every feature must obey:

- **Zero-config parity.** With no policy file, behavior is byte-for-byte the familiar
  experience: bare REPL, `/` slash commands, `@` file refs, `readonly/auto-edit/full-auto`
  approval modes. `permissivePolicy()` guarantees this. Governance is invisible until a
  company opts in.
- **Denials feel native.** A policy block reuses the existing inline, single-line,
  red/green approval UX — `⛔ Blocked by policy: <rule>` — never a stack trace or an
  enterprise dialog. Always name the rule and how to proceed.
- **No new steps in the loop.** Policy only *narrows* what's possible, silently, when an
  org configures it. The solo dev's edit/run loop gains zero confirmations.
- **New commands stay out of the way.** `trust`, `approval-pack` are discoverable but
  never on the critical path.
- **Setup is one file.** A single documented `dvalin.policy.json` with a copy-pasteable
  commented example — not a config wizard.

### 1.3 Where DvalinCode already stands

- **Verifiability / Accountability:** the hash-chained audit trail (`src/audit/`) and
  `report verify` already exist. Structural lead.
- **Containment (partial):** `src/core/permissions.ts`, three-tier approvals,
  `sandbox-exec`, `.dvalincodeignore` (`src/core/ignorefile.ts`). But containment is
  currently **developer-controlled**, not company-controlled — this is the main gap.
- **Continuity:** MIT, self-hostable, ~25MB auditable binary. Signing/notarization in
  flight. Strong, needs to be made legible.
- **Evidence-as-a-product:** essentially nonexistent today. Highest-leverage gap for
  *time-to-approval*.

---

## 2. Assumptions (override any of these)

These are the real forks. Defaults chosen so work can start; flag to change.

1. **Threat-model boundary.** The tool runs on the developer's own machine, where the
   developer ultimately has control. We therefore **cannot make policy tamper-*proof*
   against a malicious admin developer** (they can patch the binary). We make policy
   **default-enforced and tamper-*evident***, and offer an optional **server-mediated
   mode** (policy + audit held by a company-controlled `dvalincode serve` instance) for
   orgs needing hard enforcement. Approval target = the honest-majority case with
   *provable detection* of deviation. — _If you need hard enforcement against hostile
   local users as table stakes, the plan reweights heavily toward server-mediated mode._

2. **First compliance framework: SOC 2 (CC-series) + SIG-Lite / CAIQ-Lite questionnaires.**
   Most common in global B2B SaaS procurement. ISO 27001 Annex A mapping is a fast
   follow. FedRAMP / air-gap / gov is deferred unless that's your design partner.

3. **First design partner = mid-market/enterprise tech company** with a real security
   review but not a defense-grade air-gap requirement. Drives realistic, shippable
   requirements. — _If your first partner is finance/health/gov, raise ISO/air-gap._

4. **Open-core packaging.** Local agent + policy + audit + `trust` are MIT/free.
   Paid layer = team/org control plane (central policy distribution, audit
   aggregation, SSO). Doesn't change the requirements below, only what's gated later.

5. **Resourcing = solo / small, phased.** Roadmap is sequenced for incremental shipping,
   not a big-bang release.

---

## 3. Epics & requirements

Requirement IDs are stable handles for later tracking. Each has acceptance criteria (AC).

### EPIC A — Org Policy & Containment  *(Pillar: Containment)*
The transformation: turn "an agent with full tool access" (un-approvable) into
"an agent constrained by a policy the company wrote" (approvable).

- **A1 — Org policy file.** A new `dvalin.policy.json`, distinct from user config,
  discoverable at repo root and/or a system location, with precedence **org > user**.
  Controls at minimum:
  - allowed providers / model endpoints (allowlist)
  - allowed model IDs
  - shell command policy: allowlist (regex) + denylist, default-deny option
  - filesystem path allow/deny (layered on top of `.dvalincodeignore`)
  - network: `off` | `endpoint-only` | `on`
  - permitted modes: subset of `chat | cowork | code`
  - per-tool approval requirement overrides
  - max autonomy / max tool calls per run
  - **AC:** a policy that sets `mode: [chat]` + `network: off` makes Code mode and any
    outbound call refuse with a clear, logged reason; user config cannot widen it.

- **A2 — Enforcement chokepoint.** Policy is evaluated in the tool/permission layer
  (`src/core/permissions.ts` + `src/tools/registry.ts`) so *every* tool call — shell,
  writeFile, network — passes one gate. No tool bypasses it.
  - **AC:** a denied call never executes its side effect and emits an audit event
    (`policy_deny`) with the rule that triggered it.

- **A3 — Policy integrity.** The resolved policy's hash + source path is recorded in the
  audit log at `run_start`. Optional Ed25519 signature so an org can sign its policy and
  `trust verify` confirms it's the org's, unmodified.
  - **AC:** editing the policy between runs changes the recorded hash; `trust verify`
    flags an unsigned/modified policy when a signature is expected.

- **A4 — Network egress control.** A single network chokepoint for all agent-initiated
  traffic. `network: endpoint-only` permits only the configured model endpoint; every
  outbound connection is logged (`net_egress` audit event). Pair with the existing
  `sandbox-exec` network-denied profile for shell-spawned processes.
  - **AC:** in `endpoint-only`, a tool attempting any other host fails and is logged;
    a full run against a local Ollama model produces an audit log showing zero egress.

- **A5 — Server-mediated enforcement (stretch / P2).** When a client runs against
  `dvalincode serve`, policy + audit live server-side and clients cannot override.
  Builds on `src/server/security.ts` + `configStore.ts`.
  - **AC:** a client with a permissive local policy is still constrained by the server's
    policy; audit lands in the server's store.

### EPIC B — Verifiability & Self-Attestation  *(Pillar: Verifiability)*

- **B1 — `dvalincode trust`.** Emits the install-specific security posture: version;
  build signature/notarization status; SBOM reference; **resolved active policy** (with
  source + hash); egress config; audit status; dependency list. Human-readable + `--json`.
  This is the product embodiment of the North Star — the tool that issues its own
  approval evidence.
  - **AC:** output fully describes what the agent may and may not do on this machine,
    such that a reviewer needs no other source to understand the blast radius.

- **B2 — `dvalincode trust verify`.** One command checks: binary signature, policy
  integrity, and audit-chain integrity. CI-friendly exit codes.
  - **AC:** returns non-zero if any of signature / policy hash / audit chain fails;
    prints which one and where.

- **B3 — SBOM at release.** Generate a CycloneDX SBOM during `build:release`, attach to
  the GitHub release, reference it from `trust`.
  - **AC:** every release has a downloadable SBOM listing the (few) runtime deps + versions.

- **B4 — Verifiable builds + provenance.** Document and script a reproducible build so a
  third party can rebuild and compare hashes; publish SLSA-style provenance.
  - **AC:** a documented procedure yields a byte-identical (or hash-attested) binary;
    provenance attestation is attached to releases.

- **B5 — Audit → external sink.** Export audit JSONL to SIEM-friendly formats and/or
  forward (syslog/webhook). Security teams want it in *their* tools.
  - **AC:** `dvalincode report export --format <jsonl|cef>` produces ingestible output;
    optional forward delivers events to a configured endpoint.

### EPIC C — Evidence-as-a-Product (the Approval Pack)  *(Pillar: Evidence + Accountability)*
The biggest lever on *time-to-approval*.

- **C1 — `dvalincode approval-pack`.** Generates a bundle for the current install/config:
  filled SIG-Lite/CAIQ-Lite, data-flow diagram, threat model, SBOM, security FAQ,
  "letter to your CISO," and the current resolved policy snapshot.
  - **AC:** a developer runs one command and gets a directory/zip they can hand to
    their security team with no manual editing required.

- **C2 — Pre-filled standard questionnaires.** Maintain CAIQ-Lite + SIG-Lite answers as
  versioned data; generator stamps product version + date.
  - **AC:** the filled questionnaire covers ≥90% of its questions without "N/A — ask vendor."

- **C3 — Compliance control mapping.** Map audit event types and product features to
  SOC 2 CC controls and ISO 27001 Annex A; ship as a maintained table.
  - **AC:** a reviewer can point at a control (e.g. CC7.2 monitoring) and see exactly
    which DvalinCode mechanism satisfies it.

- **C4 — Trust Center page.** A `/trust` route in the web GUI (and a static export)
  presenting B1/B3/C2/C3 for a deployed instance.
  - **AC:** visiting `/trust` on a running `serve` shows live posture + downloadable pack.

### EPIC D — Continuity & Supply-Chain Trust  *(Pillar: Continuity)*

- **D1 — Signed + notarized releases, all platforms** (in flight) — finish + document.
- **D2 — Dependency hygiene** — pin, CVE-scan in CI, document each runtime dep's purpose.
- **D3 — Bus-factor / source-availability guarantee doc** — what a company retains and
  can do if the vendor disappears (rebuild, self-host, fork). Turn the solo-project
  liability into an approval *argument*.
  - **AC (D):** releases are signed; CI fails on known-critical CVEs; the continuity doc
    is referenced from the Approval Pack.

### EPIC E — Narrative & Positioning  *(P0, runs in parallel)*

- **E1 — Reposition README/site** to "approvable by default" with the objection→answer matrix.
- **E2 — Objection→answer matrix** as a canonical doc + visual (the 7-question table).
  - **AC (E):** the homepage answers "why your security team can say yes" above the fold.

---

## 4. The MVP "approval slice"

The smallest coherent end-to-end that lets a real design partner's security team say
yes **using only the generated evidence**:

```
E1 + E2            narrative / objection matrix
A1 + A2 + A4       org policy + enforcement + no-egress   ← bounds & proves the risk
B1                 `dvalincode trust`                     ← self-issued posture
C1 (minimal)       Approval Pack v0 (SIG-Lite + CISO letter + data-flow + policy snapshot)
```

Everything else (A3/A5, B2–B5, C2–C4, D, signing polish) hardens and scales this slice.

---

## 5. Phased roadmap

| Phase | Theme | Items | Exit criterion |
|---|---|---|---|
| **P0** | Narrative + Pack v0 | E1, E2, C1(min), C2(seed) | A developer can hand a security team a pack that answers the common review without engineering help. |
| **P1** | Provable containment | A1, A2, A4, B1 | The company — not the developer — controls blast radius, and `trust` proves it. |
| **P2** | Compliance-grade trust | A3, B2, B3, B4, B5, C3 | Claims are independently verifiable and mapped to named controls. |
| **P3** | Enterprise fit | A5, C4, SSO/SAML, central audit aggregation | Multi-seat orgs can centrally enforce + observe. |

---

## 6. Success metric (how we know the North Star is met)

Primary proxy: **review questions the Approval Pack + `trust` output do *not* already
answer → drive to zero**, and **time-to-approval** for a design partner.

- Leading: % of a standard SIG-Lite auto-answered by the pack.
- Lagging: a design partner's security team approves using only the pack + `trust`
  output, with **zero custom engineering requests**.

---

## 7. Key risks

- **Threat-model overreach.** Promising tamper-*proof* local enforcement is a trap
  (§2.1). Market it as tamper-*evident* + server-mediated for hard enforcement.
- **Questionnaire rot.** Pre-filled answers drift from reality → version + date-stamp
  them and regenerate from the live config where possible (C1 reads real policy).
- **Solo-vendor credibility.** Mitigated by Continuity (D3) as an *argument*, not hidden.
- **Scope creep into "general code agent" features.** Gate every feature against §1.2.
