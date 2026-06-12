# Plan: Audit Trail — Security-Grade Agent Run Report

## Goal
Every Cowork/Code run emits a tamper-evident, hash-chained JSONL audit log. The
Run Report (Markdown card + CLI) is a pure rendering layer over that log. This is
the flagship differentiator: no local agent ships verifiable behavior logs.

## Why P0 (strategic)
- REQUIREMENTS.md #19. Formula score is 1.25 **by construction** — the catch-up
  formula scores Gap=1 because nobody is ahead of us here; that's the point, not a
  reason to deprioritize.
- Answers the #1 recurring anxiety (black-box behavior / destructive changes
  without review — vibe-coding aftermath ↑7061) with structure, and is the literal
  extension of the "small enough to audit" tagline.
- Prerequisite for two later wins: the rollback audit entry (#21) and the
  evidence-backed PR assistant (P2).

## Design

### 7a — Event model + hash chain (`src/audit/log.ts`, new)
Append-only JSONL, one file per run: `~/.dvalincode/audit/run-<ts>-<id>.jsonl`.

```ts
type AuditEvent =
  | { type: 'run_start'; task: string; mode: AgentMode; codePermissionMode?: CodePermissionMode;
      provider: string; model: string; cwd: string; gitHead: string | null }
  | { type: 'tool_call'; tool: string; argsSummary: string; status: 'ok'|'error'; durationMs: number }
  | { type: 'file_read';   path: string; sha256: string }
  | { type: 'file_write';  path: string; added: number; removed: number; beforeHash: string|null; afterHash: string }
  | { type: 'file_delete'; path: string; beforeHash: string }
  | { type: 'shell_exec'; command: string; exitCode: number; sandbox: 'seatbelt'|'bwrap'|'none' }
  | { type: 'approval'; toolName: string; approved: boolean; diffHash?: string }
  | { type: 'policy_violation'; rule: string; tool: string; target: string }   // from plan 08
  | { type: 'run_end'; status: 'done'|'interrupted'|'error'; iterations: number;
      inputTokens?: number; outputTokens?: number };

type AuditRecord = AuditEvent & { seq: number; ts: string; prevHash: string };
```

`AuditSink` class:
- `constructor(runId, meta)` opens the file; computes `prevHash` for the genesis
  event as `sha256(runId)`.
- `append(event)`: `record = { ...event, seq, ts, prevHash }`; `hash =
  sha256(canonicalJSON(record))`; write `record` as one line; set `prevHash = hash`
  for the next event. **canonicalJSON** = stable key order so verification is
  deterministic.
- Append is **best-effort**: a write failure is caught, counted, and surfaced as a
  single `run_end.warnings` note — it must never throw into the agent loop
  (non-functional requirement).
- Size policy: file contents are never stored — only `sha256` + `added/removed`
  line counts. Long `argsSummary`/`command` truncated to 512 chars.

`verifyChain(runId): { ok: boolean; brokenAtSeq?: number }` — re-reads the file,
recomputes each hash, and checks `record.prevHash === hashOf(previous)`.

### 7b — Wiring the taps (single chokepoint + run boundary)
The registry is already the one place every tool flows through, and the loop owns
the run boundary — so taps are minimal and centralized.

- **`src/core/context.ts`** — add optional `audit?: AuditSink` to
  `DvalinContext`/`DvalinContextOptions`. Plumbed through `createDvalinContext`.
- **`src/tools/registry.ts` `run()`** — after `tool.run()` resolves, emit
  `tool_call` (name, status, duration). For write/edit/delete, derive
  `file_write`/`file_delete` from the result `metadata` that already exists
  (`writeFile`/`editFile` produce `metadata.diff` + original content; hashes are
  computed from those). For `read_file`, emit `file_read`. For `shell`, emit
  `shell_exec` from `metadata.sandbox` + exit code. The `approval` event is emitted
  where the approval promise resolves (registry.ts:52). All taps are
  `context.audit?.append(...)` — no-ops when audit is absent (CLI ask/headless).
- **`src/agent/loop.ts` `processMessage`** — wrap `TurnState.RUN`: emit
  `run_start` before constructing the runner, `run_end` after, with iteration/usage
  data already in `LoopResult`. (Keeps the sink lifecycle tied to exactly one user
  turn = one run.)
- **`src/server/wsHandler.ts`** — instantiate one `AuditSink` per
  `loop.processMessage` call (wsHandler.ts:392), inject via the context built at
  wsHandler.ts:356, and after the run send a new WS event
  `{ type: 'run_report', runId, markdown }` alongside the existing `done`
  (wsHandler.ts:90). `gitHead` resolved once from the existing git helper.

### 7c — Run Report renderer (`src/audit/report.ts`, new)
`renderReport(runId): string` reads the JSONL and produces Markdown:
`Task` · `Files read` · `Files changed (+N/−M per path)` · `Commands run (exit)` ·
`Decisions` (extracted from the run's final assistant message / plan steps) ·
`Diff summary` · `Test result` (heuristic: last `shell_exec` matching a
test/lint command + its exit code). Pure function over the log → trivially testable.

### 7d — CLI (`src/commands/report.ts`, new; registered in `src/cli.ts`)
Follows the existing `register*Command(program)` / commander pattern.
```
dvalincode report --last
dvalincode report <run-id> --format markdown|json
dvalincode report verify <run-id>   # prints ✓ chain intact OR ✗ broken at seq N
```
`--last` resolves the newest file in the audit dir.

### 7e — GUI card (`web/src/components/RunReportCard.tsx`, new)
On the `run_report` WS event, append a collapsible card at the end of the thread
(rendered by `ChatThread`): summary line collapsed; expanded shows the Markdown
with Copy / Export buttons. Read-only; styling matches `AgentActivity`/`PlanCard`.

## File Changes
1. `src/audit/log.ts` — new: event types, `AuditSink` (append + hash chain), `verifyChain`
2. `src/audit/report.ts` — new: JSONL → Markdown renderer
3. `src/audit/hash.ts` — new: `sha256`, `canonicalJSON`, file-content hashing helper
4. `src/core/context.ts` — add `audit?: AuditSink`
5. `src/tools/registry.ts` — emit tool_call / file_* / shell_exec / approval events in `run()`
6. `src/agent/loop.ts` — emit run_start / run_end around `TurnState.RUN`
7. `src/server/wsHandler.ts` — per-run sink; emit `run_report` WS event + report card data
8. `src/commands/report.ts` + `src/cli.ts` — `report --last|<id>|verify`
9. `web/src/types.ts` — `run_report` ServerEvent; `web/src/hooks/useChat.ts` — handle it
10. `web/src/components/RunReportCard.tsx` + `ChatThread.tsx` — render the card
11. `tests/audit/log.test.ts`, `tests/audit/report.test.ts` — chain integrity, tamper detection, report-vs-diff parity
12. `docs/AUDIT-TRAIL.md` — format spec + threat model (defends: post-hoc forensics, behavior trace; does **not** defend: local root attacker who can rewrite the whole chain)

## Verification
- Run any Cowork/Code task → a JSONL exists with `run_start` … `run_end` and a
  `tool_call` (+ matching `file_*`) for every tool the run made.
- `report verify <id>` on an untouched log prints ✓; hand-edit one line →
  prints ✗ with the correct `seq`.
- Report "Files changed" lines match `git diff --numstat` for the same run.
- Kill the audit dir's write permission mid-run → run still completes; `run_end`
  carries a warning; agent output unaffected.
- `npm run check` passes.

## Risk note
The hash chain is tamper-**evident**, not tamper-**proof**: a local attacker who can
rewrite the file can recompute the whole chain. State this plainly in
`docs/AUDIT-TRAIL.md` — the value is forensic/accountability, not cryptographic
custody. Don't oversell it.
