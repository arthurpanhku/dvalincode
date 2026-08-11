---
layout: home

hero:
  name: DvalinCode
  text: Open security engineering for human and agent-written code
  tagline: Discover · remediate · verify — run Dvalin independently or alongside any security agent, with a local policy-bound gate before merge.
  image:
    light: /logo-light.png
    dark: /logo-dark.png
    alt: DvalinCode
  actions:
    - theme: brand
      text: Install in 60 seconds
      link: '#install'
    - theme: alt
      text: Why approvable?
      link: /APPROVABILITY-PLAN
    - theme: alt
      text: GitHub
      link: https://github.com/arthurpanhku/dvalincode

features:
  - icon: 🔒
    title: Org policy bounds the agent
    details: A company — not the developer — constrains modes, shell commands, paths, tools, and models via dvalin.policy.json. A repo policy can only narrow the machine policy, never widen it.
    link: /POLICY-REFERENCE
    linkText: Policy reference
  - icon: 🛡️
    title: Tamper-evident audit trail
    details: Every run emits a hash-chained JSONL log — every file read/written, every command, every approval. Verify the chain offline with `dvalincode report verify`.
    link: /AUDIT-TRAIL
    linkText: Threat model
  - icon: 🏛️
    title: Evidence, not claims
    details: OpenSSF Scorecard, CodeQL, pinned Actions, ISO/IEC 42001 alignment docs, and an offline-verifiable Evidence Pack — maintained as reviewable project artifacts.
    link: /EVIDENCE-PACK
    linkText: Evidence pack
  - icon: 🔑
    title: Any agent or security source
    details: Codex Security, CodeQL, GitHub Code Scanning, Semgrep, Trivy, OSV-Scanner, or another SARIF producer can hand evidence to the same local Dvalin gate.
    link: /DVALIN
    linkText: Interoperability
  - icon: 💻
    title: Local-first, zero-dep binary
    details: One ~25 MB executable per platform. No Node, no Python, no Docker. Sessions, config, and audit logs stay in ~/.dvalincode on your machine.
  - icon: 🧰
    title: Dvalin security engineering
    details: Orchestrate the built-in scanner, Semgrep CE, Trivy, and OSV-Scanner; fix selected evidence; test and re-scan; then explicitly prepare a draft PR.
    link: /SECURE-REMEDIATION
    linkText: Workflow
---

## Install and run Dvalin in 60 seconds {#install}

Don't take the claims on trust — verify them on your own machine:

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
dvalincode trust
dvalincode dvalin . --scanners builtin,semgrep,trivy,osv-scanner
```

The Dvalin command runs the built-in rules and any supported open-source engines
installed on `PATH`. Use `--fix --verify --in-place` to prepare focused repairs,
run tests, and require a clean re-scan before draft-PR publication.

![Dvalin real scan and verified remediation](/dvalin-remediation.gif)

The real case shown above is adapted from OWASP NodeGoat. It moved from 10
findings and 22/F to 0 findings and 100/A after the three `eval` call sites were
replaced by a constrained numeric parser and an injection regression test was
added. The score is a triage heuristic, not certification.

Dvalin combines the MIT-licensed DvalinCode pipeline with open-source
[Semgrep CE](https://github.com/semgrep/semgrep),
[Trivy](https://github.com/aquasecurity/trivy),
[OSV-Scanner](https://github.com/google/osv-scanner), and SARIF 2.1
interoperability. Scanner evidence guides the configured model; DvalinCode
records the diff, runs project tests, re-scans, and keeps PR publication explicit.
Specialist agents such as Codex Security can export SARIF into the same case and
gate workflow without Dvalin taking ownership of their credentials or sealed
scan artifacts. Dvalin can also run the complete discovery, remediation, and
verification loop itself; interoperability is an option, not the product
boundary.

Prove what the agent did after the fact:

```sh
dvalincode report verify    # re-derive the hash chain of the last run's audit log
```

Windows builds and manual downloads for every platform are on the
[releases page](https://github.com/arthurpanhku/dvalincode/releases/latest),
with `SHA256SUMS.txt` and build provenance attestation for each archive.

## One binary, three frontends

Run `dvalincode` bare for an interactive **terminal agent** with streaming
output, inline approvals, and red/green diffs — or `dvalincode serve` to host
the **web GUI** for browser and remote use. An experimental **desktop app**
ships on a separate pre-release track. All three drive the same agent core.
CI, schedulers, and external agents can drive that core through the headless
`dvalincode run` command or the task-level stdio `dvalincode mcp-serve`
surface, with the same policy and audit chokepoint.

![DvalinCode web GUI](/hero.png)

## Built for every team that needs an independent security decision

DvalinCode is an **agent-compatible security runtime** that can run alone,
compete in security discovery and remediation, or interoperate with specialist
systems. It does not try to replace every general coding agent. The product is
the discovery, evidence, remediation, and enforcement layer a security,
compliance, or platform team needs before human- or agent-written code can merge:

- **Controllable** — an [org policy](/POLICY-REFERENCE) bounds the blast radius.
- **Transparent** — `dvalincode trust` makes the posture self-verifiable.
- **Auditable** — the [hash-chained log](/AUDIT-TRAIL) proves what every run did.

Start with the [threat model](/THREAT-MODEL) to see the full attack surface —
malicious `AGENTS.md`, poisoned MCP servers, prompt-injection escalation,
egress, audit tampering — each mapped to the control that defends it and the
honest residual gap.

## Is DvalinCode for you?

An honest fit check — we compete on measurable security outcomes and
approvability, not on being everything.

**Choose DvalinCode when…**

- A security or compliance review stands between your team and AI coding — you need **evidence** (policy hash, verifiable audit chain, an exportable Evidence Pack), not vendor claims.
- The org — not each developer — must set the boundaries: allowed commands, paths, models, MCP servers, network egress.
- You need model freedom or fully offline operation (local models, any OpenAI-compatible endpoint), with data staying on your machines.

**Look elsewhere when…**

- You just want the strongest general coding autopilot and governance isn't a constraint — Claude Code or Codex will serve you better today.
- You want in-IDE autocomplete — that's Copilot/Cursor territory; DvalinCode is a terminal/web agent runtime.
