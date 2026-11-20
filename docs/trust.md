# Trust and governance

**English** · [中文](zh/trust.md)

A verdict is worth only as much as the runtime that issues it. This page
collects what a security reviewer needs to check Dvalin itself: an
organization, not the developer, bounds what it may do; every run is
hash-chained into a tamper-evident audit log; and nothing reaches a model
provider that the egress guard did not allow. A repo policy can only ever
*narrow* the machine-level one.

If you are the person who has to approve this class of tool, start at the
[Approvability Plan](APPROVABILITY-PLAN.md) and the
[Evidence Pack](EVIDENCE-PACK.md) that every release ships of itself.

## Controllable, transparent, auditable

Governance is built in, not bolted on. An org policy bounds the blast radius
(**controllable**), `dvalincode trust` makes the posture self-verifiable
(**transparent**), and the hash-chained log proves what every run did
(**auditable**). Those three together are what a security review needs to say
yes.

- **Org policy & `trust`** — A company, not the developer, bounds the agent. A
  `dvalin.policy.json` constrains modes, shell commands, file paths, tools, and
  models; a repo policy can only ever *narrow* the machine-level one, never
  widen it. Each run records the governing policy's hash. `dvalincode trust`
  prints the install's live security posture — active policy + hashes, audit
  status, runtime — so a reviewer can verify it directly.
  [Policy reference →](POLICY-REFERENCE.md)
- **Audit trail** — Every run emits a tamper-evident, hash-chained JSONL log:
  every file read/written, every command, every approval. A Run Report renders
  it as Markdown, and `dvalincode report verify` proves the chain is intact.
  [Audit trail →](AUDIT-TRAIL.md)
- **Open specs** — **PCP-1** writes the provider-boundary contract (egress
  containment, credential containment, audit, policy binding) as a
  vendor-neutral profile with test procedures, so any agent runtime can run it
  against its own adapters and publish the result: a checklist anyone can hold
  us to as well. [Provider Conformance Profile →](spec/PROVIDER-CONFORMANCE.md) ·
  [Fix Verification Profile (FVP-1) →](spec/FIX-VERIFICATION.md)

You can prove what the agent did after the fact:

```sh
dvalincode report verify    # re-derive the hash chain of the last run's audit log
```

## Evidence for a security review

DvalinCode maintains project-level governance evidence for open-source and
enterprise review:

- **Threat model** — the full attack surface of an agentic coding runtime
  (malicious `AGENTS.md`, poisoned MCP servers, prompt-injection escalation,
  egress, audit tampering, supply chain, sandbox escape), each mapped to the
  control that defends it and the honest residual gap.
  [Threat model →](THREAT-MODEL.md)
- **OpenSSF Scorecard support** — scheduled Scorecard workflow, SARIF upload,
  CodeQL, Dependabot, CODEOWNERS, least-privilege workflow permissions, and
  SHA-pinned GitHub Actions. [Control map →](security/OPENSSF-SCORECARD.md)
- **ISO/IEC 42001 alignment** — an AI management system scope, AI policy, role
  map, risk register, AI change classification, required records, and review
  cadence. [AIMS alignment →](governance/ISO-42001-AIMS.md)
- **AI change impact assessment** — a reusable template for changes that affect
  model/provider behavior, prompts, permissions, tools, audit logs, or release
  security. [Template →](governance/AI-CHANGE-IMPACT-ASSESSMENT.md)
- **Release evidence** — every release ships an Evidence Pack the binary
  produced of itself. [Release evidence →](RELEASE-EVIDENCE.md)
- **Regulated-use posture** — local-first data handling, policy-controlled
  autonomy, minimized audit records, and release supply-chain evidence for
  finance, healthcare, security-sensitive SaaS, and internal enterprise use.

These documents are implementation evidence and operating procedures; they do
not claim third-party ISO certification.
