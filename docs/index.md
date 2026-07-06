---
layout: home

hero:
  name: DvalinCode
  text: The approvable coding agent for regulated teams
  tagline: Any model · local-first · policy-bound · audit-ready — AI coding your security team can actually approve.
  image:
    src: /logo.png
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
    title: Any model, no lock-in
    details: DeepSeek, OpenAI, Claude via OpenRouter, Groq, Ollama, or any OpenAI-compatible endpoint. Switch with one click — run fully offline with local models.
  - icon: 💻
    title: Local-first, zero-dep binary
    details: One ~25 MB executable per platform. No Node, no Python, no Docker. Sessions, config, and audit logs stay in ~/.dvalincode on your machine.
  - icon: 🧰
    title: Secure remediation built in
    details: Scan locally or import SARIF from CodeQL, GitHub Code Scanning, or Semgrep — findings become isolated remediation worktrees with PR-ready reporting.
    link: /SECURE-REMEDIATION
    linkText: Workflow
---

## Install in 60 seconds {#install}

Don't take the claims on trust — verify them on your own machine:

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
dvalincode trust
```

`trust` prints this install's **live security posture**: the resolved org policy and its hash, per-boundary network enforcement (provider · shell · MCP), and the tamper-evident audit status — the exact evidence a security reviewer needs, straight from the tool itself.

Then let the agent work, and prove what it did after the fact:

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

![DvalinCode web GUI](/hero.png)

## Built for teams that need a "yes" from security

DvalinCode is an **approvable agent runtime**, not just another coding agent.
The product is the evidence a security, compliance, or platform team needs to
safely allow AI coding in finance, healthcare, and other confidential
codebases:

- **Controllable** — an [org policy](/POLICY-REFERENCE) bounds the blast radius.
- **Transparent** — `dvalincode trust` makes the posture self-verifiable.
- **Auditable** — the [hash-chained log](/AUDIT-TRAIL) proves what every run did.

Start with the [threat model](/THREAT-MODEL) to see the full attack surface —
malicious `AGENTS.md`, poisoned MCP servers, prompt-injection escalation,
egress, audit tampering — each mapped to the control that defends it and the
honest residual gap.
