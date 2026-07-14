# SWE-bench Lite — run log & findings

Cross-run observations from the smoke harness. One section per run; newest
first. Numbers here are from the **local-venv smoke harness** (see
[README](../README.md) caveats) — not official-harness comparable.

<!-- runs appended below -->

## 2026-07-14 — first baseline sweep · random ×15 · **2/15 (13.3%)**

Batch [`results/batches/20260714-000434/`](batches/20260714-000434/SUMMARY.md) ·
`deepseek-coder` · local-venv harness (`python3.11`) · `--sample 15`.
Classification below is **after** the eval-layer fixes (see next section).

| Bucket | n | Note |
|---|---|---|
| `env` | 5 | matplotlib ×2, scikit-learn ×3 — old C-extension builds fail on python3.11 |
| `env_broken_at_test` | 4 | pytest 4.4/5.4 (`lineno`/`pkg_resources` — old pytest can't run under 3.11) + sympy-17655 (`py` incompat) |
| `unresolved_fix_failed` | 3 | pytest-8906, sympy-14024, sympy-21612 — agent ran, F2P still failed |
| `resolved` | 2 | sympy-24152, sphinx-10325 |
| `evaluate` | 1 | flask-4992 — agent created a `tests/` fixture, colliding with the held-out `test_patch` |

**The real story is the denominator, not the 13.3%.** Nine of 15 instances
(`env` 5 + `env_broken_at_test` 4 = **60%**) never gave the agent a working
environment — the intended interpreter/deps predate 3.11. On the **6 instances
that fairly measured the agent** (resolved 2 + unresolved_fix_failed 3 +
evaluate 1), **2 resolved (~33%)**. Environment fidelity, not agent capability,
is the dominant blocker — the concrete case for Phase 2 (official per-instance
Docker images).

**Two genuine agent failures**, both causal-tracing errors: sympy-21612 edited
`parsing/latex/` when the bug was in `printing/str.py` (misled by the issue's
surface wording); sympy-14024 changed 4 unrelated files and hit the 40-iteration
cap (1.18M tokens, no convergence). Both point at "reproduce-before-editing" and
a progress/stop heuristic (see roadmap). flask-4992's `evaluate` failure is a
constraint violation — the agent created a `tests/` fixture a source-only task
forbids; candidate fix: enforce it via an org policy that denies `tests/` writes
(dogfoods our own governance).

**Eval-layer fixes applied this session** (the sweep hardened the harness):
- **Two harness bugs**: the `ERR` trap didn't fire on a failing `( subshell )`
  under `set -e` (matplotlib's pip build) → switched to an `EXIT` trap;
  `write_result`'s node step read `process.env` vars that were never exported →
  failure results crashed under `set -u`, mislabeling env failures
  `harness_error`.
- **False agent-failure attribution fixed**: pre-check now distinguishes a real
  test *failure* from a broken *environment* (pytest exit-code + `N failed`
  summary), quarantining dead envs as `env_broken_at_test` and **skipping the
  agent** instead of burning tokens. This alone moved 4 instances out of
  `unresolved_fix_failed` — the agent ran on **5/15 now vs 9/15 before**,
  cutting wasted agent runs.
- **Shallow-clone version fix**: `SETUPTOOLS_SCM_PRETEND_VERSION` from the
  instance's `version` cleared the spurious `minversion` gate (pytest reported
  `0.1.dev1` with no tags). It unblocked pytest-8906 (v7.0, now runs) and
  *revealed* the deeper 3.11 incompatibilities in pytest 4.4/5.4 — which the
  local venv fundamentally cannot fix.

Takeaway for the next sweep: restrict the local subset to 3.11-friendly repos
(sympy/sphinx/flask/newer-pytest) for a clean capability read, and reserve the
old-Python repos for the Docker harness.

## 2026-07-13 — batch infra validation · sympy ×3 · **0/3** (harness works)

First run of the batch pipeline (`fetch-dataset` → `run-batch` → `summarize`)
on 3 unseen sympy instances (11400, 11870, 11897). All completed the pipeline;
**0 resolved** — every one bucketed `unresolved_fix_failed` (agent produced a
real 0.9–2.9 KB patch, didn't touch tests, but the target F2P test still failed;
two also regressed P2P). Legit non-resolutions, not harness bugs.

Signal worth chasing: on hard instances (no fix in the issue, unlike 24152),
`deepseek-coder` **thrashed to the iteration cap** — 35/40/40 iterations and
**~1.87M input tokens/instance** (vs 104k for the easy one). Uncached input at
that volume is the dominant cost; reinforces prompt-caching / native adapters on
the roadmap, and suggests an iteration-budget + better stop heuristic. This is
the kind of failure-mode datapoint the classification buckets are meant to
surface across a full sweep.

## 2026-07-13 — sympy__sympy-24152 · **RESOLVED** ✅ (re-run after shell fix)

Run: [`results/sympy__sympy-24152/20260713-233122/`](sympy__sympy-24152/20260713-233122/) ·
audit run `2026-07-13T15-31-45-863Z-dbb2ea9a111a`, chain head `de84a9db…f417c7a8`

Same instance, same harness, after the exit-71 shell fix (`/bin/sh -c` spawn).
The agent could finally **execute** — it validated its own patch with
`… venv/bin/python -m pytest … 2>&1 | tail -30` → **exit 0** (the `cd &&`,
pipe, and redirect that used to fail all worked) before declaring done.

| Metric | Before (blind) | After (fix) | Δ |
|---|---|---|---|
| Verdict | resolved | resolved | — |
| Iterations | 21 | **9** | −57% |
| Tool calls | 20 (13 wasted) | **8 (0 wasted)** | −60% |
| Input tokens | 342,348 | **103,858** | −70% |
| Wall-clock | 49.9 s | **31.6 s** | −37% |
| Self-validated with pytest | ❌ (blind) | ✅ exit 0 | — |

The first run resolved only because the issue text embedded the fix; this run
the agent independently ran the held-in tests and saw them pass. Model here is
`deepseek-coder` (first run: `deepseek-chat`). Governance held: audit chain
intact, sandbox still denied network (verified separately).

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
   → ENOENT → exit 71 (`EX_OSERR`). **Fixed** (2026-07-13): `buildLaunch` now
   routes the inner command through `/bin/sh -c <script>` in every sandbox mode
   (`command` = shell line, `args` appended shell-quoted); regression tests in
   `tests/shellSeatbeltExec.test.ts` run real subprocesses through seatbelt and
   confirm network stays denied. Whatever the
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

- [x] Repro + root-cause exit-71 → `shell: false` argv bug. **Fixed**:
      `/bin/sh -c` spawn in `buildLaunch` + `tests/shellSeatbeltExec.test.ts`.
- [x] Re-run this instance now the fix has landed — tool-call waste 13/20 → 0/8,
      input tokens 342k → 104k, agent self-validated with pytest
      (`results/sympy__sympy-24152/20260713-233122/`).
- [ ] 5–10 instance mini-sweep once agent-side validation works.
