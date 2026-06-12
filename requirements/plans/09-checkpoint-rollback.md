# Plan: Checkpoint / Rollback — Run-Level Snapshot

## Goal
Upgrade operation-level `/undo [N]` to a one-click **run-level** rollback: snapshot
before a run, and after it offer Rollback / Keep / Commit. Removes the "the agent
changed a pile of files and I can't cleanly revert" fear. Cheap (wraps git) — ship
it, but it's parity, not the headline.

## Why P1 (strategic)
- REQUIREMENTS.md #21. Unlike #19/#20 this is a genuine catch-up (Gap 3): Cursor
  has checkpoints, Claude Code has rewind; we only have op-level undo
  (`sharedUndoStack` / `runner.undoLast` in `src/agent/runner.ts`).
- Low cost because git does the heavy lifting; pairs naturally with the audit
  trail (the rollback is itself an audited event).

## Design

### 9a — Snapshot before a run (`src/core/checkpoint.ts`, new)
At the start of `TurnState.RUN` (Cowork/Code only — Chat writes nothing), create a
non-destructive snapshot that does **not** touch the working tree or index:
- **Git repo**: `git stash create` → returns a dangling commit SHA of the current
  dirty state (without modifying the working tree). Record
  `{ runId, kind: 'git', stashCommit, head, ts }`. If the tree is clean,
  `stash create` returns empty → record `{ kind: 'git', stashCommit: null, head }`
  (nothing to restore beyond `head`).
- **Non-git dir**: degrade to a file-level snapshot — copy the files the run is
  *about* to touch on first write into `~/.dvalincode/checkpoints/<runId>/`
  (lazy, driven by the registry's write tap), or, if that's too invasive for v1,
  record `{ kind: 'unsupported' }` and tell the user rollback isn't available here.
  **Acceptance requires the explicit "unsupported" notice at minimum.**
- Persist the manifest to `~/.dvalincode/checkpoints/<runId>.json`.

### 9b — Post-run choice (GUI + WS)
After `run_end`, the server includes checkpoint info in the existing `done`/new
`run_report` event. The thread renders three actions (next to the Run Report card):
- **Rollback this run** → `POST /api/checkpoint/rollback { runId }`
- **Keep changes** → dismiss (default; no-op)
- **Create git commit** → opens the commit message flow (reuses existing git plumbing)

### 9c — Rollback (`src/core/checkpoint.ts` + route)
```ts
rollback(runId): Promise<{ ok: boolean; conflicts?: string[] }>
```
- **Git**: compute the set of paths the run wrote (from the audit log's
  `file_write`/`file_delete` events — plan 07 — or the checkpoint manifest).
  Detect **post-run user edits**: if a written file's current hash ≠ the run's
  recorded `afterHash`, the user touched it after the run → add to `conflicts` and
  **do not** silently overwrite; return conflicts for the UI to confirm.
  For non-conflicting paths, restore each from the snapshot:
  `git checkout <head> -- <path>` for files that existed pre-run, and for files the
  run *created*, `rm` them; apply the stashed dirty state back where relevant.
  (Scope the restore to run-touched paths so unrelated work is never reverted.)
- **File-level**: copy back from `~/.dvalincode/checkpoints/<runId>/`, same
  conflict check via hashes.
- Emit a `rollback` audit event (extend plan 07's event union) recording runId,
  restored paths, and any conflicts.

### 9d — CLI (`src/commands/checkpoint.ts`, new; registered in `src/cli.ts`)
```
dvalincode checkpoint list            # runId · time · #files · git|file|unsupported
dvalincode rollback <run-id>          # prompts on conflicts unless --force
```

## File Changes
1. `src/core/checkpoint.ts` — new: `snapshot()`, `rollback()`, manifest I/O, conflict detection
2. `src/agent/loop.ts` — call `snapshot()` at `TurnState.RUN` entry (Cowork/Code)
3. `src/server/wsHandler.ts` — surface checkpoint info post-run; `POST /api/checkpoint/rollback`, `GET /api/checkpoint/list`
4. `src/audit/log.ts` — add `rollback` event type (depends on plan 07)
5. `web/src/components/RunReportCard.tsx` (or a sibling) — Rollback / Keep / Commit actions + conflict confirm dialog
6. `web/src/lib/client.ts` — `rollbackRun()`, `listCheckpoints()`
7. `src/commands/checkpoint.ts` + `src/cli.ts` — `checkpoint list`, `rollback <id>`
8. `tests/checkpoint.test.ts` — new: clean rollback leaves `git status` clean; created-file rollback removes it; post-run user edit → conflict (no silent overwrite); non-git → unsupported notice

## Verification
- Code-mode run edits 3 files → **Rollback** → `git status` is clean (back to
  pre-run state); the 3 files match their pre-run content.
- Run creates `new.ts` → rollback removes it.
- User hand-edits one of the run's files after the run, then rollback → that file
  is reported as a conflict and left untouched unless confirmed/`--force`.
- Non-git directory → run still works; checkpoint reports `unsupported` and the UI
  hides Rollback (or shows it disabled with a reason).
- Rollback writes a `rollback` event to the run's audit log.
- `npm run check` passes.

## Risk note
`git stash create` + scoped `checkout` is non-destructive, but a careless restore
could clobber concurrent user edits — hence the mandatory hash-based conflict gate
(silent overwrite is an explicit acceptance failure). Keep the restore **scoped to
run-touched paths**; never `git reset --hard` the whole tree. Defer dirty-stash
re-application edge cases (partial conflicts) behind the conflict prompt rather
than auto-merging.
