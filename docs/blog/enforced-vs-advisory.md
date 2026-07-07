---
title: "Enforced vs advisory: what \"sandboxed\" really means in an AI coding agent"
description: Most AI coding agents describe safety features they cannot actually enforce. Here is how we draw the line in DvalinCode — and why we publish the gaps.
head:
  - ['meta', { property: 'og:title', content: 'Enforced vs advisory — honest sandboxing in AI coding agents' }]
  - ['meta', { property: 'og:description', content: 'A control you cannot enforce is a claim, not a control. How DvalinCode separates enforced guarantees from advisory ones — and publishes the residual gaps.' }]
---

# Enforced vs advisory: what "sandboxed" really means in an AI coding agent

*Published by the DvalinCode maintainers.*

Ask most AI coding agents whether they are "safe" and you will get a list of
features: sandboxing, approvals, allow-lists, audit logs. Ask *how each one is
enforced* and the list gets shorter. A lot of agent "safety" is **advisory** —
behavior the model is asked to follow, or a wrapper that can be talked around —
dressed up in the language of **enforcement**.

For a tool whose entire pitch is being **approvable by a security review**, that
gap is the whole game. So DvalinCode draws one hard line through every feature:

> A control is only real if it holds **when the model is adversarial** — because
> sooner or later, some input makes it so.

Here is what that line looks like in practice.

## The model is untrusted, and so is everything it reads

The single most important design decision is where authority comes from. In
DvalinCode it does **not** come from the prompt. A malicious `AGENTS.md`, a
poisoned file, a hostile MCP tool description — all of it is untrusted text that
can carry injected instructions. If the agent's permissions lived in the prompt,
prompt injection would be privilege escalation.

Instead, every side effect flows through **one chokepoint** — `registry.run` —
where the resolved org policy is evaluated *in code*, out of band from the model:

- The prompt can say "ignore your rules and run `curl … | sh`" all it wants.
- The tool call still hits `checkCommand` / `checkPath` / `checkTool` against the
  policy first.
- A denied action is denied regardless of how convincingly the model was
  persuaded — and the attempt is recorded as a `policy_violation`.

This is the difference between *advisory* ("the system prompt tells the agent not
to") and *enforced* ("the code refuses, no matter what the agent decided").

## "Sandboxed" should mean the OS says no

"Runs in a sandbox" is one of the most abused phrases in this space. Plenty of
agents mean "we prepend a warning" or "we check the command string with a
regex." DvalinCode's shell tool means the operating system refuses the syscall:

| Platform | Mechanism | Under a restrictive policy |
|----------|-----------|----------------------------|
| macOS | `sandbox-exec` (Seatbelt), `(deny network*)` | **enforced** |
| Linux | Bubblewrap, `--unshare-net` | **enforced** |
| Windows | *no v1 mechanism* | **fails closed** — the command is not run |

Two things matter here. First, the network denial is enforced by the kernel, not
by asking nicely. Second — and this is the part most projects skip — when we
*can't* enforce isolation (Windows in v1), we **fail closed**: the launch is
blocked, never run "advisory." A sandbox that silently degrades to no sandbox is
worse than no sandbox, because it lies to the reviewer.

## Egress is a policy decision, at three boundaries

Data exfiltration is the number-one concern a security team has about an AI
agent. So "can this thing phone home" is a policy setting (`network: off /
endpoint-only / on`) enforced at every boundary that can open a socket:

- **Provider HTTP** — checked per request, with redirect revalidation.
- **Shell subprocesses** — the OS sandbox above.
- **MCP servers** — a remote MCP gateway is *not* the model endpoint, so under
  `endpoint-only` it is correctly **blocked**, not quietly allowed.

`dvalincode trust` prints the live status of each boundary, so a reviewer reads
the posture off the tool instead of off a marketing page.

## The honest part: we publish what we *can't* enforce

This is where "honest" stops being a slogan. Every enforced control above has a
residual gap, and hiding them would defeat the point of being verifiable. So the
[threat model](/THREAT-MODEL) states them plainly:

- The audit trail is tamper-**evident**, not tamper-**proof**. A local root can
  delete a whole run file; the hash chain proves what *remains* is intact and
  makes some deletions detectable — but it does not prevent destruction.
- Redirect-then-rebind (DNS rebinding) after an egress check is not fully closed.
- Windows subprocess isolation is unavailable (hence fail-closed).
- A *correctly-policied* agent taking an in-scope-but-unwise action is bounded,
  not prevented. We limit blast radius; we do not read intent.

Each gap is mapped to a roadmap item, not buried. A reviewer who finds one of
these on their own — after we swore everything was airtight — stops trusting the
whole document. A reviewer who finds it *already written down, with the
mitigation* trusts the rest more.

## Why this is the only defensible position

You cannot out-benchmark the frontier labs on raw coding ability, and you
shouldn't try. But "here is exactly what I enforce, here is what I don't, and
here is the command you can run to verify both" is a claim the big cloud agents
structurally struggle to make — and it is exactly what an approver needs to say
yes.

Enforced beats advisory. Verifiable beats trustworthy. And an honestly-documented
gap beats a silently-broken guarantee every single time.

---

*DvalinCode is an open-source, local-first AI coding agent built to be approvable
by a security review. Verify any of the above on your own machine:*

```sh
curl -fsSL https://raw.githubusercontent.com/arthurpanhku/dvalincode/main/scripts/install.sh | bash
dvalincode trust
```

*Read the full [threat model](/THREAT-MODEL) · [Evidence Pack](/EVIDENCE-PACK) ·
[GitHub](https://github.com/arthurpanhku/dvalincode).*
