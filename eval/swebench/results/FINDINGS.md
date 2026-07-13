# SWE-bench Lite — run log & findings

Cross-run observations from the smoke harness. One section per run; newest
first. Numbers here are from the **local-venv smoke harness** (see
[README](../README.md) caveats) — not official-harness comparable.

<!-- runs appended below -->

## 2026-07-13 — sympy__sympy-24152 · **RESOLVED** ✅ (first harness run)

Run: [`results/sympy__sympy-24152/20260713-170716/`](sympy__sympy-24152/20260713-170716/) ·
audit run `2026-07-13T09-07-40-168Z-8d3e9497faac`, chain head `a7d3d073…f2cf9540`

| Metric | Value |
|---|---|
| Verdict | **resolved** (F2P 1/1 passed, P2P 6/6 passed) |
| Model | `deepseek-chat` (Code mode / bypass) |
| Wall-clock | 49.9 s |
| Iterations / tool calls | 21 / 20 |
| Tokens | 342,348 in / 3,354 out |
| Patch | semantically identical to the gold patch (`args_cnc()` + `Mul(*c_part)*Mul(*nc_part)`) |

### Findings

1. **Sandbox blocked 100% of subprocess execution — the run succeeded *blind*.**
   All 11 shell commands exited **71 `(sandbox: seatbelt)`**, including
   `echo hello` and `/bin/echo hello`; `run_check` failed the same way. The
   agent burned **13 of 20 tool calls (~35 s of 50 s)** probing for a working
   interpreter, then gave up on validation, applied the fix via `edit_file`,
   and declared done. It resolved only because the issue text contained the
   proposed fix. **Root cause (follow-up session): not a seatbelt
   profile/path bug** — the `shell` tool spawned with `shell: false`, so the
   model's full command line (`cd X && python …`, even `/bin/echo hello`)
   became a single argv element; under seatbelt, `sandbox-exec` execvp()s it
   → ENOENT → exit 71 (`EX_OSERR`). Fix (spawn via `/bin/sh -c`; regression
   tests in `tests/shellSeatbeltExec.test.ts`) is pending merge. Whatever the
   cause, the datapoint stands: **with zero working execution, ~65% of agent
   actions were wasted and validation was impossible** — an upper-bound
   preview of what heavy execution restriction costs.

2. **Token amplification without caching: ~16 k input tokens re-sent per
   iteration** (342 k input for 21 iterations vs 3.4 k output). With a
   provider that bills cached input cheaply this is survivable; on frontier
   pricing it is not. Supports moving native provider adapters (prompt
   caching) up the roadmap.

3. **Audit chain held up end-to-end** under a fully autonomous bypass run:
   minimized task descriptor (sha256), per-command exit codes with sandbox
   annotations, files read/changed, run id + chain head — the Run Report told
   us exactly what the agent did and what the sandbox denied, with zero extra
   instrumentation. This is the evidence-pack story working as designed.

### Caveats

- This is among the easiest Lite instances (the issue includes the fix);
  resolving it says the harness works, not that the agent generalizes.
- Local-venv evaluation, not the official Docker harness (see README).

### Follow-ups

- [x] Repro + root-cause exit-71 → `shell: false` argv bug, fix pending merge
      (`/bin/sh -c` spawn + `tests/shellSeatbeltExec.test.ts`).
- [ ] Re-run this instance after the fix merges (`npm run build` first —
      the driver imports `dist/`) and compare tool-call waste.
- [ ] 5–10 instance mini-sweep once agent-side validation works.
