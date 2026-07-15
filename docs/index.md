---
layout: home

hero:
  name: DvalinCode
  text: The approvable coding agent for regulated teams
  tagline: Any model · local-first · policy-bound · audit-ready — AI coding your security team can actually approve.
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
    title: Any model, no lock-in
    details: DeepSeek, OpenAI, Claude via OpenRouter, Groq, Ollama, or any OpenAI-compatible endpoint. Switch with one click — run fully offline with local models.
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

![Dvalin 0.14.0 real scan and verified remediation](/dvalin-014-remediation.gif)

The real v0.14.0 case shown above is adapted from OWASP NodeGoat. It moved from
6 findings and 49/F to 0 findings and 100/A after three source fixes and a new
injection regression test. The score is a triage heuristic, not certification.

Dvalin combines the MIT-licensed DvalinCode pipeline with open-source
[Semgrep CE](https://github.com/semgrep/semgrep),
[Trivy](https://github.com/aquasecurity/trivy),
[OSV-Scanner](https://github.com/google/osv-scanner), and SARIF 2.1
interoperability. Scanner evidence guides the configured model; DvalinCode
records the diff, runs project tests, re-scans, and keeps PR publication explicit.

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

![Dvalin 0.14.0 scanner workspace](/dvalin-014-scan-before.png)

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

## Is DvalinCode for you?

An honest fit check — we compete on approvability, not on being everything.

**Choose DvalinCode when…**

- A security or compliance review stands between your team and AI coding — you need **evidence** (policy hash, verifiable audit chain, an exportable Evidence Pack), not vendor claims.
- The org — not each developer — must set the boundaries: allowed commands, paths, models, MCP servers, network egress.
- You need model freedom or fully offline operation (local models, any OpenAI-compatible endpoint), with data staying on your machines.

**Look elsewhere when…**

- You just want the strongest general coding autopilot and governance isn't a constraint — Claude Code or Codex will serve you better today.
- You want in-IDE autocomplete — that's Copilot/Cursor territory; DvalinCode is a terminal/web agent runtime.
