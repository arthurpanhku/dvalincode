# Contributing

Thanks for helping improve DvalinCode. Contributions of all sizes are welcome — docs, tests, bug reports, and features.

**The North Star** (it decides every design argument): *make DvalinCode trivially approvable by any company's security review* — controllable, transparent, auditable — while staying as convenient as any mainstream coding agent.

## Getting started

```sh
git clone https://github.com/arthurpanhku/dvalincode
cd dvalincode
npm install
npm run check        # typecheck + full test suite — must be green before and after your change
npm run build && node dist/index.js trust   # see the governance surface you're working on
```

Good entry points are labeled [`good first issue`](https://github.com/arthurpanhku/dvalincode/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22). Larger items live in [ROADMAP.md](ROADMAP.md) and issues labeled `help wanted`. If you want to work on something, comment on the issue so we don't duplicate effort — **maintainers aim to respond to new PRs and issues within 48 hours.**

## Architecture in five lines

- `src/agent/` — the turn loop (`session.ts` → `loop.ts` → `runner.ts`); all three frontends (TUI, web, desktop) drive the same `runAgentTurn`.
- `src/tools/` — every capability is a typed `Tool` registered in `registry.ts`. **`registry.run` is the single policy + permission + audit chokepoint.**
- `src/core/policy.ts` — org policy, resolved by *narrowing* (a repo policy can only tighten a machine policy, never widen it).
- `src/audit/` — tamper-evident, hash-chained, minimized run logs. `src/mcp/`, `src/providers/` — all outbound network goes through a governed fetch.
- `docs/` — design docs with acceptance matrices ([EGRESS-THREAT-MODEL](docs/EGRESS-THREAT-MODEL.md), [GOVERNED-MCP](docs/GOVERNED-MCP.md), [DURABLE-SESSION](docs/DURABLE-SESSION.md)). Read the one covering your area before coding.

## The governance rules (non-negotiable)

These are what make the project what it is. A PR that violates one will be asked to restructure, no matter how useful the feature:

1. **No side doors.** Anything that produces a side effect, network egress, or a permission change must pass through the existing chokepoints (`registry.run`, `governedProviderFetch` / `governedMcpFetch`, `runGovernedProcess`) — never a direct `fetch`/`exec`/`spawn`.
2. **Narrowing only.** Policy changes may add restrictions; they may never let a repo-level source widen a machine-level one, and must keep the canonical policy hash stable for unchanged policies.
3. **Minimize, don't leak.** Audit records carry hashes, sizes, and structure — never prompts, file contents, shell arguments, or credentials.
4. **Honest enforcement.** If a control can't be enforced on some platform, it fails closed or reports `unavailable` — it is never silently advisory. Document exemptions in the threat model instead of hiding them.
5. **Zero runtime deps is a feature.** New runtime dependencies need a very strong case; prefer hand-rolling small clients (see `src/mcp/client.ts` for the pattern).

## Everyday guidelines

- Keep tools small and explicit; add a Zod schema for every tool input.
- Put permission-sensitive behavior behind the permission model and declare `policyTargets`.
- Add tests for new core behavior — governance guarantees get *bypass tests* (prove the block actually blocks).
- Match the surrounding code's style; no drive-by reformatting.
- Do not copy code, prompts, or product text from proprietary or unclear-license projects.

## Pull requests

- Conventional-commit style titles (`feat:`, `fix:`, `docs:`, `test:` …).
- Say **what** changed, **why**, and **how you tested it** (paste the `npm run check` tail).
- Security-sensitive changes (policy, audit, egress, sandbox, credentials): note the impact explicitly and update the relevant threat-model doc in the same PR.
- One logical change per PR — small PRs get reviewed fast.

## Reporting security issues

**Not** via public issues — see [SECURITY.md](SECURITY.md) for private reporting and scope.
