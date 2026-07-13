# SWE-bench Lite smoke harness

First step toward measuring the **governance tax**: what does full governance
(per-write approvals, sandboxed shell, audit chain) cost in task success rate,
wall-clock time, and tokens? This harness runs a single
[SWE-bench Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite)
instance against DvalinCode end-to-end and records both **outcome** metrics
(resolved / F2P / P2P) and **governance** metrics (audit run id, chain head,
tool calls, iterations, tokens).

## Usage

```bash
npm run build                                   # driver imports from dist/
bash eval/swebench/run-one.sh sympy__sympy-24152
# env overrides: PYTHON=python3.11  AGENT_TIMEOUT_MIN=25
```

The agent runs in **Code mode / Bypass Permissions** through `runAgentTurn` —
the same governed entry point the web GUI and TUI use, so org policy stays
enforced and every tool call lands in the audit chain (`dvalincode report`).
Provider/model come from `~/.dvalincode/config.json` and are recorded in the
result.

## What gets recorded

`results/<instance_id>/<timestamp>/`:

| File | Contents |
|---|---|
| `result.json` | resolved verdict, F2P/P2P exit codes, model, iterations, tool calls, tokens, wall-clock, audit `runId` + `auditHead` |
| `agent.diff` | the model patch (staged diff, incl. new files) |
| `agent.log` | live tool-call trace from the run |
| `prompt.txt` | exact prompt given to the agent |
| `report.md` | DvalinCode Run Report (audit trail rendering) |
| `pre-f2p.log` / `f2p.log` / `p2p.log` | pytest output at base / after patch |

`FINDINGS.md` collects observations across runs.

## Honest caveats (read before quoting numbers)

- **Not the official harness.** Official SWE-bench evaluation runs each
  instance in a purpose-built Docker image; this harness uses a local venv
  (`PYTHON`, default `python3.11`). Environment drift is possible. Use the
  official harness for any reportable/comparable numbers.
- **pytest-runnable repos only.** Full pytest ids are used as-is; bare
  test-name entries (sympy style) are resolved against the test file in
  `test_patch` — only when it touches exactly one file. Django-style ids and
  multi-file bare-name instances fail loudly.
- **Single-instance smoke tool.** No parallelism, no retries, no pass@k.
- The evaluation step follows SWE-bench convention: agent edits to test files
  touched by the held-out `test_patch` are reverted before testing (recorded
  as `agent_touched_tests`).
