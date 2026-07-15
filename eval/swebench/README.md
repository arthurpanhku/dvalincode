# SWE-bench Lite smoke harness

First step toward measuring the **governance tax**: what does full governance
(per-write approvals, sandboxed shell, audit chain) cost in task success rate,
wall-clock time, and tokens? This harness runs a single
[SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite)
instance against DvalinCode end-to-end and records both **outcome** metrics
(resolved / F2P / P2P) and **governance** metrics (audit run id, chain head,
tool calls, iterations, tokens).

## Usage

### One instance

```bash
npm run build                                   # driver imports from dist/
bash eval/swebench/run-one.sh sympy__sympy-24152
# env overrides: PYTHON=python3.11  AGENT_TIMEOUT_MIN=25  AGENT_MAX_ITERATIONS=25
```

### Batch (the runnable subset)

```bash
node eval/swebench/fetch-dataset.mjs            # cache all 300 Lite instances + manifest
bash eval/swebench/run-batch.sh --repo sympy --limit 20
# other selectors: --sample N (random) · --ids a,b,c · --resume results/batches/<ts>
# env: PYTHON=python3.11  AGENT_TIMEOUT_MIN=15  AGENT_MAX_ITERATIONS=25  INSTANCE_TIMEOUT_MIN=20
```

`fetch-dataset.mjs` pulls the whole `test` split (falling back to the hub
parquet CDN when the HF datasets-server is down) and writes
`instances/_lite.json` — a manifest that flags each instance **runnable** or not
under this local-venv harness (django and multi-file bare-name instances are
excluded; **173/300 runnable**). `run-batch.sh` runs the selected subset into
`results/batches/<ts>/<instance_id>/`, is **resumable** (instances with a
`result.json` are skipped), applies a per-instance wall timeout, and writes a
`SUMMARY.md` via `summarize.mjs` — resolved rate, **failure classification by
stage** (`unresolved_fix_failed` / `p2p_regression` / `env` / `instance_timeout`
/ …), per-repo rate, and token/latency totals.

> **`timeout(1)` not on macOS by default** — install coreutils (`brew install
> coreutils`, gives `gtimeout`) for a hard per-instance wall timeout; otherwise
> only the agent-internal `AGENT_TIMEOUT_MIN` bounds a run.

The agent runs in **Code mode / Bypass Permissions** through `runAgentTurn` —
the same governed entry point the web GUI and TUI use, so org policy stays
enforced and every tool call lands in the audit chain (`dvalincode report`).
Provider/model come from `~/.dvalincode/config.json` and are recorded in the
result. A per-run **source-only runtime policy** narrows any machine/repo policy
and rejects file-tool writes under test directories; denials are fed back to the
agent and recorded in the audit chain. The normal local precheck now requires
F2P to fail **and P2P to pass** at base before spending agent tokens.

### Phase 2 — official Docker evaluation

The local-venv path above measures the *agent under governance*, but it grades
in a `python3.11` venv that can't reproduce each repo's intended environment —
**40–60% of Lite instances can't even run their tests there** (see
[`results/FINDINGS.md`](results/FINDINGS.md)). Phase 2 keeps the agent run on the
host under full governance and moves only the **grading** into the official
SWE-bench per-instance Docker images, so the resolved verdict is comparable to
published numbers *and* every instance gets a faithful environment.

```bash
# 1. Produce patches for the whole selection. --no-precheck skips the venv gate
#    so env-broken instances still run and yield a patch to grade:
bash eval/swebench/run-batch.sh --tier friendly --sample 30 --no-precheck

# 2. Grade those patches in Docker with the official harness:
bash eval/swebench/run-eval-docker.sh results/batches/<ts>
#    → predictions.jsonl · <model>.<run_id>.json (official report) · SUMMARY.official.md
```

Requires **Docker** (daemon running) and the **`swebench`** package — the script
bootstraps it into a cached `.venv-tools` venv, or point `SWEBENCH_PY` at a
python that already has it. `SUMMARY.official.md` puts the official resolved rate
next to the on-host governance/cost metrics (tokens, iterations, audit head) and
flags every instance where the local venv and official Docker disagree.

| Helper | Role |
|---|---|
| `predictions.mjs` | batch `agent.diff`s → SWE-bench `predictions.jsonl` |
| `run-eval-docker.sh` | preflight (docker + swebench) → `swebench.harness.run_evaluation` → summary |
| `summarize-official.mjs` | official report × our per-instance records → `SUMMARY.official.md` |

## What gets recorded

`results/<instance_id>/<timestamp>/`:

| File | Contents |
|---|---|
| `result.json` | resolved verdict, F2P/P2P exit codes, model, iterations, tool calls, input/output + cache hit/miss/write tokens, wall-clock, audit `runId` + `auditHead` |
| `agent.diff` | the model patch (staged diff, incl. new files) |
| `agent.log` | live tool-call trace from the run |
| `prompt.txt` | exact prompt given to the agent |
| `report.md` | DvalinCode Run Report (audit trail rendering) |
| `pre-f2p.log` / `f2p.log` / `p2p.log` | pytest output at base / after patch |

`FINDINGS.md` collects observations across runs.

## Honest caveats (read before quoting numbers)

- **Two harnesses, two numbers.** The default local-venv path
  (`run-one`/`run-batch`) is a fast smoke harness — a `python3.11` venv,
  environment drift possible, **not comparable** to published numbers. For
  reportable/comparable numbers use **Phase 2** (`run-eval-docker.sh`), which
  grades the same patches in the official per-instance Docker images. Quote
  local-venv numbers only with this caveat.
- **pytest-runnable repos only.** Full pytest ids are used as-is; bare
  test-name entries (sympy style) are resolved against the test file in
  `test_patch` — only when it touches exactly one file. Django-style ids and
  multi-file bare-name instances fail loudly.
- **Serial batch, no pass@k.** `run-batch.sh` is resumable but runs instances
  one at a time (the agent shares `~/.dvalincode` audit/session state, so
  parallelism needs isolation work first). No retries, no pass@k.
- **Official denominator includes failures.** `predictions.mjs` submits empty
  and missing patches as empty predictions, so stalled/crashed agent runs are
  counted rather than silently excluded.
- The evaluation step follows SWE-bench convention: agent edits to test files
  touched by the held-out `test_patch` are reverted before testing (recorded
  as `agent_touched_tests`).
