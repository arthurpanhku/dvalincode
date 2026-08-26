# Verification Surfaces Plan — carry the verification work to every surface

> **Premise:** `docs/spec/FIX-VERIFICATION.md` made a Verified Fix Record the thing
> this project produces. Coverage, fix records, and offline re-derivation now exist —
> but only two of seven surfaces can see them. This plan carries them to the rest.

This is a handoff document. Every phase states what to change, which existing code to
reuse, and an acceptance criterion that is a **test**, not a manual check.

---

## 1. Context

The question this started from was narrower: *does the TUI need refactoring?* Answering it
turned up a second finding that matters considerably more than the first.

### 1.1 The TUI does not need refactoring

423 lines across three files, and the layering is already right:

| File | Lines | Role |
|---|---|---|
| `src/tui/app.ts` | 291 | REPL and lifecycle only |
| `src/tui/render.ts` | 108 | pure formatting, zero IO, unit-tested by `tests/tui/render.test.ts` (93 lines) |
| `src/tui/presets.ts` | 24 | static config |

`app.ts` shows the marks of having been debugged rather than merely written: double-SIGINT
force-quit, an abort signal threaded through `askLine`, a `settled` guard against
double-resolve, chalk auto-disabled off a TTY. Rewriting it trades working code for risk.

What it has is **three specific gaps** (§4), not a structural problem.

### 1.2 The real finding: verification reached the CLI and MCP, and stopped

Presence of the new concepts (`coverage` / `fixRecord` / `verify-fix`) by surface:

| Surface | coverage | fixRecord | verify-fix |
|---|---|---|---|
| `src/mcp` | yes | yes | yes |
| `src/tui` | no | no | no |
| `web/src` | no¹ | no | no |
| `src/gui` (desktop) | no | no | no |
| `editors/vscode/src` | no | no | no |
| `src/server` | no | no | no |
| `src/harness` | no | no | no |

¹ The `coverage` matches in `web/src/components/DvalinWorkspace.tsx` are prose, not data.
Line 414 renders *"Review scanner coverage before treating this as assurance"* under a
green "No actionable findings" — asking the user to do by hand what `deriveCoverage()`
now computes automatically. That line is the bug in miniature: an empty finding list is
presented as a good outcome, with the caveat delegated to the reader.

**The CLI itself needs no change.** Both binaries already expose the verification exit:
`dvalincode` has 46 commands including `security verify-fix`; `dvalin` has 12 including
`verify-fix`. That part landed correctly.

### 1.3 The bottleneck is the server, not the GUIs

`src/server/routes/remediation.ts:64` calls `runDvalinScanSuite(cwd, …)` directly and
responds `{ ...result, cases }` — **bypassing `executeSecurityScan`**. So there is no
coverage, no baseline delta, no gate, no envelope in the response.

The two GUIs are therefore not merely unfinished; they have no data to render. The server
has to be fixed before either can display anything. That fixes the ordering below.

---

## 2. Ordering

```
Phase 1  server contract        →  unblocks phase 3
Phase 2  three TUI fixes        →  independent, can run in parallel
Phase 3  web GUI + desktop GUI  →  depends on phase 1
Phase 4  VS Code extension      →  last, smallest payoff
```

---

## 3. Phase 1 — give the server the contract (do first)

**File:** `src/server/routes/remediation.ts`

- `POST /suite`: call `executeSecurityScan` (already exported at
  `src/commands/security.ts:313`) instead of `runDvalinScanSuite`, and return the full
  envelope — `scan` / `coverage` / `delta` / `gate` / `workflowId` / `schemaVersion`.
- **Preserve backward compatibility.** The current response spreads the scan result at the
  top level (`{ ...result, cases }`). Keep those top-level fields and the `cases` array;
  add the new fields alongside rather than nesting the old ones under `scan`. An existing
  front end must not break.
- **Keep the workspace grant as the security boundary.** The route derives `cwd` from
  `consumeScannerWorkspaceGrant(body.grant)`; pass that as `root`. Do not widen it.
- **Handle the baseline case.** With `gate.mode === 'new'`, `executeSecurityScan` throws
  `UsageError` when no baseline exists. Map that to a 400 with its message intact — not a
  500, and not a silent downgrade to `all` mode, which would report a pass the project
  never earned.
- Decide `saveWorkflow` deliberately. A GUI scan writing a workflow record on every click
  is probably not wanted; `saveWorkflow: false` is the safer default for this route.
- Add `POST /verify-fix`: accept a fix record JSON body, run `verifyFixRecord`
  (`src/security/fixRecord.ts:167`), respond `{ ok, reasons, record }`. Purely offline —
  it must not touch the workspace, and so needs no grant.

**Acceptance**

- A `POST /suite` response carries `coverage.status ∈ {complete, partial, unknown}`.
- With engines missing, that status is `partial` and `coverage.deferred` is non-empty.
- Every field the old response had is still present, asserted field by field.
- A tampered record posted to `/verify-fix` returns `ok: false` with a reason containing
  `recordHash mismatch`.
- A `new`-mode scan with no baseline returns 400, not 500.

## 4. Phase 2 — three targeted TUI changes (no refactor)

### 4.1 Drop the dependency on a private Node API — the one real defect

`src/tui/app.ts:236-255`, inside `askMasked` (line 234), overwrites `rl._writeToOutput` to
suppress echo while the user types an API key:

```ts
const iface = rl as unknown as { _writeToOutput?: (s: string) => void };
```

That field is undocumented Node internals. If a Node release renames or stops calling it,
**the API key echoes in plaintext** — and nothing throws, so nothing announces it. This is
a silent-failure mode on a secret, which is the worst shape a bug can take.

Replace it with controlled reading that does not reach inside `readline.Interface`:
either `process.stdin.setRawMode(true)` with manual character collection, or `rl.question`
followed by an immediate line clear. Whichever is chosen, the TTY state must be restored on
**every** exit path — normal return, throw, and Ctrl-C.

**Acceptance**
- A new test asserts typed input is not echoed.
- A new test asserts TTY state is restored after a throw and after an abort.
- `grep -rn "_writeToOutput" src/` returns nothing.

### 4.2 Show the real diff at the approval point

`approvalLine` (`src/tui/render.ts:79`) clips its input to 80 characters (lines 19-22), so
a `write_file` approval shows a truncated path and nothing else. This product's central
claim is that approval is the control point; the web GUI has a `DiffViewer`, while the TUI
sits on the same security boundary unable to see what it is approving.

`colorizeDiff` already exists at `src/tui/render.ts:34` — the machinery is built, it is
simply not used at the approval point. Have the approval path render a diff for
`write_file` / `edit_file`, reusing the structured diff from `src/core/diffPreview.ts`.
Fold long diffs and state the total line count rather than silently truncating.

**Acceptance**: `tests/tui/render.test.ts` gains cases asserting a `write_file` approval
renders `+`/`-` coloured lines plus the file path, and that an over-long diff is folded
with its true total line count shown.

### 4.3 Connect the verification exit

The TUI is the only surface with no way to see a Verified Fix Record. Add:

- a `/verify-fix <path>` local command in the `handleLocal` switch, calling
  `verifyFixRecord` and reusing `renderFixRecord`;
- `coverage.status` displayed alongside the results of a scan;
- both reflected in `helpText()` and `banner()`.

**Acceptance**: `/verify-fix` prints a VERIFIED summary for a valid record and the failure
reasons for a tampered one; a `helpText()` test asserts `verify-fix` appears.

## 5. Phase 3 — both GUIs consume the phase 1 contract

- `web/src/components/DvalinWorkspace.tsx`: replace the hand-written caveat at line 414
  with a real coverage badge (complete / partial / unknown), expandable to list `deferred`
  and `exclusions`. Render a fix record as a card, labelling the executor
  **"recorded, not consulted"** — the record is evidence about the repair, not an
  endorsement of whatever produced it.
- `src/gui` (desktop webview) reads the same data; no separate fetch path is needed.

**Acceptance**: with engines missing, the UI shows `partial` and names the missing engines;
a scan with zero findings but `partial` coverage **must not** be presented as "secure".
That last one is the point of the whole plan — assert it.

## 6. Phase 4 — VS Code extension (last, smallest payoff)

`editors/vscode/` is unpublished. Adding a coverage note to Problems-panel entries is
enough; no fix-record UI.

---

## 7. Explicitly not doing

- **No Ink / blessed full-screen TUI rewrite.** readline plus append-only stdout does
  foreclose redraw regions, a persistent status bar, and resize handling — but that is a
  trade-off, not a defect: the current shape pipes, greps, and degrades automatically off a
  TTY. Trading 423 lines for thousands, and rewriting lifecycle handling that has already
  been debugged, only pays if full-screen interaction is actually required. If it ever is,
  that is a separate proposal, not part of this plan.
- No changes to `release.yml`, packaging scripts, or the Homebrew formula. This plan
  changes neither the version nor the shape of any artifact.

---

## 8. Verification

- `npm run check` stays green. Baseline at time of writing: **504 tests across 68 files**.
- Every acceptance criterion above requires a **new test**, not a manual check.
- After phase 1, exercise the missing-engine case for real rather than with a mock: a
  typical dev machine has only `builtin` available, with `semgrep` / `trivy` / `osv-scanner`
  missing, so `coverage.status` must come back `partial`. It is a ready-made natural
  fixture — use it before trusting the unit tests alone.
- §4.1 (the `askMasked` change) touches how a secret is handled: run `/security-review` before merging it.
