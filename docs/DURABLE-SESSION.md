# Durable Session v1 Design

## Scope

Today a turn is only persisted once, at the very end: `runAgentTurn` calls
`loop.processMessage(...)` and then overwrites the whole-session JSON snapshot
(`src/sessions/store.ts`). If the process dies mid-turn, the user's input and
any progress are lost, and there is no record that a turn was ever attempted.
There is also no idempotency: re-submitting the same logical message runs it
again.

Durable Session v1 adds a small, demonstrable vertical slice on top of the
existing snapshot, mirroring the audit log's append-only design:

1. An append-only **session journal** (one JSONL file per session) that records
   a turn's *intent* before it runs and its *outcome* after.
2. **Message idempotency** keyed by a caller-supplied `messageId`.
3. **Crash recovery**: a turn that started but never finished is detectable on
   the next load, and the user's input is preserved rather than lost.
4. An **audit anchor**: every turn is linked to its audit run by stable ids in
   both directions, and the journal records the audit chain head hash as a
   checkpoint.

This version does **not** add an input queue/inbox, cross-session scheduling, a
new storage engine (SQLite), or steering. Those are deferred (see Non-goals).

## Trust boundary

The journal is **session state**, the same trust level as the existing
`<id>.json` snapshot: it may contain the user's raw message text, because
recovering that text intact is the whole point. This is deliberately distinct
from the **audit chain**, which is minimized (hashes, not content). The two are
linked by ids, never by copying content across the boundary.

## Storage layout

```
~/.dvalincode/sessions/<id>.json            # existing snapshot (fast load projection)
~/.dvalincode/sessions/<id>.journal.jsonl   # new append-only journal
```

The snapshot remains the canonical fast-load view and is still written at turn
end, so every existing reader keeps working unchanged. The journal is additive.

## Journal records

Append-only JSONL; each record carries `seq` and `ts`.

| Record | Fields | When |
|--------|--------|------|
| `turn_start` | `messageId`, `content`, `cwd`, `mode` | before `loop.processMessage` |
| `turn_end` | `messageId`, `status` (`done`/`error`/`interrupted`), `runId`, `auditHead`, `iterations` | after the turn settles (success or failure) |
| `turn_interrupted` | `messageId`, `reason` | when recovery closes a turn that crashed before `turn_end` |

`auditHead` is the audit sink's hash-chain head after `run_end` — the checkpoint
that ties this turn to a specific, verifiable point in the audit log.

## Status projection

Session status is derived from the journal tail (it is not stored):

- empty journal, or last record is `turn_end`/`turn_interrupted` → **idle**
- a `turn_start` with no matching terminal record → **interrupted**
  (observed only across process boundaries; a live in-process turn is `running`
  in memory and never written as a dangling start)

## Idempotency

`messageId` is supplied by the caller. When omitted, `runAgentTurn` generates a
fresh id per invocation, so default behavior is unchanged. A transport that
wants safe retransmits (e.g. the WebSocket handler reusing a client message id)
opts in by passing a stable `messageId`. Before running, `runAgentTurn` looks up
the journal:

- a `turn_end` with `status: done` for this `messageId` already exists →
  **replay**: return the current session state with `replayed: true`, without
  re-executing the model.
- otherwise → run normally.

A fresh, unique `messageId` (the default when none is supplied) always runs;
idempotency only engages when a caller deliberately reuses an id (e.g. a
retransmit after a dropped connection).

## Crash recovery

`recoverSession(id)` scans the journal for dangling `turn_start` records (no
terminal record), returns them — preserving each interrupted turn's `messageId`
and `content` — and appends a `turn_interrupted` record so the journal becomes
consistent and the same turn is not reported as interrupted forever. The caller
decides whether to re-run or discard; v1 surfaces them, it does not auto-resume.

## Audit anchor (bidirectional link)

- audit `run_start` gains an optional `sessionId` (audit → session).
- journal `turn_end` records `runId` and `auditHead` (session → audit, plus the
  verifiable checkpoint hash).

No content crosses the boundary; only ids and a hash. `dvalincode report verify
<runId>` still verifies the audit chain independently; the `auditHead` in the
journal lets a reviewer confirm which audit run a given turn produced.

## Acceptance matrix

| Case | Expected result |
|------|-----------------|
| New turn, no `messageId` | Runs; journal has `turn_start` then `turn_end:done`; snapshot updated |
| Same `messageId` after a completed turn | Replayed; model not re-invoked; `replayed: true` |
| Turn throws/interrupted | `turn_end` recorded with `status: error`/`interrupted`, not left dangling |
| Process crash mid-turn (no `turn_end`) | `recoverSession` returns the turn with its original input; appends `turn_interrupted` |
| Status of a session whose last record is `turn_start` (prior process) | `interrupted` |
| Status of a clean session | `idle` |
| `turn_end` of a successful turn | Carries the same `runId` returned to the caller and a non-empty `auditHead` |
| audit `run_start` for a turn | Carries the turn's `sessionId` |
| No journal present (pre-upgrade session) | Loads from snapshot as before; first new turn starts a journal |
| Audit chain | `verifyChain` still passes; minimization unchanged |

## Non-goals (deferred)

- Input queue / inbox and `steer`/`queue` semantics.
- Automatic resume of an interrupted turn (v1 surfaces, caller decides).
- SQLite or any new storage engine.
- Cross-session parallelism or a run coordinator.
- Storing model/tool intermediate state for fine-grained resume inside a turn.
