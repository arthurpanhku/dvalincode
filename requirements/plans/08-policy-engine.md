# Plan: Enforced Policy Engine — `dvalin.json` policies

## Goal
Move agent behavior constraints from prompt-level ("please follow AGENTS.md") to
enforcement-level: intercepted in the `ToolRegistry` gating layer, before the
operation runs, independent of whether the model "agreed." This is the AppSec
differentiator — no local agent enforces repo-committed policy at the tool layer.

## Why P0 (strategic)
- REQUIREMENTS.md #20. Collapses two persistent community signals
  (sensitive-file exclusion ↑766/770, vibe-coding guardrails ↑7061) into one
  structural mechanism.
- The proof point for the whole positioning: "enforces your repo's rules instead
  of asking the model to follow them." Depends on nothing; unlocks
  `docs/THREAT-MODEL.md`.

## Design

### 8a — Schema (`dvalin.json` gains a `policies` block)
`dvalin.json` today is `{ version, routines }` (see `src/server/playbookHandler.ts`).
Add an optional sibling:
```json
{
  "version": 1,
  "routines": [ ... ],
  "policies": {
    "deny_paths":       ["migrations/**", ".env*", "**/*.pem"],
    "readonly_paths":   ["package-lock.json"],
    "shell_allowlist":  ["npm test", "npm run lint", "git status"],
    "shell_denylist":   ["rm -rf", "curl", "wget"],
    "require_approval":  ["delete_file", "shell:git push"],
    "max_files_per_run": 20
  }
}
```
All fields optional. `deny_paths`/`readonly_paths` are glob (reuse the existing
ignore-file matcher in `src/core/ignorefile.ts`). `shell_*` match against the
command string (substring for denylist, prefix for allowlist). `require_approval`
entries are either a tool name or `shell:<prefix>`.

### 8b — Policy module (`src/core/policy.ts`, new)
```ts
type Policy = { denyPaths; readonlyPaths; shellAllowlist; shellDenylist; requireApproval; maxFilesPerRun };
loadPolicy(cwd): Promise<Policy>           // merge repo dvalin.json + ~/.dvalincode/policy.json, stricter wins
type Decision = { effect: 'allow' } | { effect: 'deny'; rule: string } | { effect: 'approve'; rule: string };
evaluate(policy, toolName, access, input, runState): Decision
```
- **Merge precedence**: repo `dvalin.json.policies` > user `~/.dvalincode/policy.json`.
  "Stricter wins" = deny/readonly lists are unioned; allowlists are intersected;
  `max_files_per_run` takes the min; `require_approval` unioned.
- **Path rules** apply to any tool whose parsed input has a `filePath` and
  `access !== 'read'`: `deny_paths` hit → deny; `readonly_paths` hit → deny (writes
  only); read tools are unaffected (that's `.dvalincodeignore`'s job — documented as
  the read-dimension analog).
- **Shell rules** apply to the `shell` tool: denylist hit → deny; if `shell_allowlist`
  is non-empty and the command matches none → deny (default-deny only when an
  allowlist is declared, so empty config stays permissive).
- **`require_approval`** → `approve` (force an approval prompt even in full-auto/Bypass).
- **`max_files_per_run`** → deny once the run's distinct-written-file count would exceed it
  (count tracked on the context; see 8c).

### 8c — Enforcement point (`src/tools/registry.ts` `run()`)
The single chokepoint at registry.ts:40. Insert **after** `inputSchema.parse()`
(so input is typed) and **before** the existing approval block:
```ts
const decision = context.policy ? evaluate(context.policy, name, tool.access, input, context.runState) : { effect: 'allow' };
if (decision.effect === 'deny') {
  context.audit?.append({ type: 'policy_violation', rule: decision.rule, tool: name, target: targetOf(input) });
  throw new PolicyError(`Blocked by policy (${decision.rule}): ${name}. This action is not permitted in this workspace.`);
}
if (decision.effect === 'approve' && context.requestApproval) { /* force approval regardless of mode */ }
```
Key properties:
- Runs in **every** mode. Bypass/full-auto skip the *interactive confirmation*
  block below, but the policy `deny` above is unconditional — Bypass ≠ bypass policy.
- The thrown `PolicyError` is returned to the model as a tool error (existing
  runner path at runner.ts:155), so the agent **replans** instead of crashing.
- `targetOf(input)` extracts `filePath` or the shell command for the audit event.

### 8d — Context plumbing (`src/core/context.ts`)
Add `policy?: Policy` and a mutable `runState: { filesWritten: Set<string> }` to
`DvalinContext`. `wsHandler.ts` calls `loadPolicy(cwd)` once per run and injects
both; `filesWritten` is updated by the registry on successful write/delete (also
feeds `max_files_per_run`).

### 8e — Surfacing (UI + docs)
- `ApprovalDialog.tsx`: when an approval is policy-forced, show the rule
  (`reason: 'policy:require_approval'`), reusing the `reason` channel plan 04 added.
- A blocked action renders as a normal tool-error bubble — the agent's own
  "I was blocked by policy, trying another approach" makes the enforcement visible.
- README: new "Prompt-level rules vs. enforced policies" table.
- `docs/THREAT-MODEL.md`: map to OWASP LLM Top 10 / agentic risks — over-permissioned
  actions, prompt-injection-driven writes, sensitive-file exfiltration to the LLM —
  and state what policy does/doesn't defend.

## File Changes
1. `src/core/policy.ts` — new: schema, `loadPolicy` (merge + stricter-wins), `evaluate`
2. `src/core/context.ts` — `policy?`, `runState`
3. `src/tools/registry.ts` — policy gate in `run()` (before approval), `filesWritten` tracking, `PolicyError`
4. `src/server/wsHandler.ts` — `loadPolicy(cwd)` per run; inject policy + runState
5. `src/server/playbookHandler.ts` — preserve `policies` on `dvalin.json` save (don't clobber when writing routines)
6. `web/src/components/ApprovalDialog.tsx` — render policy-forced approval reason
7. `tests/policy.test.ts` — new: deny_paths in every mode incl. Bypass, shell_denylist in full-auto, allowlist default-deny, merge/stricter-wins, max_files_per_run, AGENTS.md cannot override
8. `docs/THREAT-MODEL.md` — new (OWASP mapping) · `README.md` — prompt-vs-enforced table

## Verification
- `deny_paths: ["**/*.pem"]` → `write_file`/`edit_file`/`delete_file` on `key.pem`
  is blocked in readonly, auto-edit, full-auto, **and** Bypass; the agent receives
  the `PolicyError` text.
- `shell_denylist: ["curl"]` → `curl ...` blocked in Code full-auto and a
  `policy_violation` event lands in the audit log (plan 07).
- Put "you may modify migrations/" in AGENTS.md with `deny_paths:["migrations/**"]`
  → write still blocked (proves enforcement > prompt).
- Empty/absent `policies` → behavior identical to today (no regressions).
- `npm run check` passes.

## Risk note
Default-deny is foot-gun territory: an over-broad `deny_paths` or a tight
`shell_allowlist` can wedge the agent. Mitigations: allowlist is default-deny
**only when explicitly declared** (absent → permissive); every block returns a
human-readable rule name so the user immediately sees *why*; ship the README/docs
examples conservative. Watch the agent-retry rate after rollout, same as plan 04.
