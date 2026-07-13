# Batch summary — `20260714-000434`

Generated 2026-07-13T16:29:08.972Z · harness: local-venv smoke (non-official).

## Headline

- **Resolved: 2/15 (13.3%)**
- Model(s): `deepseek-coder`
- Agent ran on 9/15 instances (rest failed before the agent).

## Outcome / failure classification

| Bucket | Count | Share |
|---|---|---|
| `unresolved_fix_failed` | 7 | 46.7% |
| `env` | 5 | 33.3% |
| `resolved` | 2 | 13.3% |
| `evaluate` | 1 | 6.7% |

Buckets: `resolved` (F2P+P2P pass) · `unresolved_fix_failed` (target test still fails) · `p2p_regression` (fix works but breaks held-out tests) · `env` (venv/pip) · `precheck*` (bad instance/env drift) · `resolve_unsupported` (test-id mapping) · `agent` (agent crash) · `instance_timeout` · `harness_error`.

## Per-repo resolved rate

| Repo | Resolved | Rate |
|---|---|---|
| pytest-dev | 0/4 | 0.0% |
| sympy | 1/4 | 25.0% |
| scikit-learn | 0/3 | 0.0% |
| matplotlib | 0/2 | 0.0% |
| pallets | 0/1 | 0.0% |
| sphinx-doc | 1/1 | 100.0% |

## Cost & latency (agent instances only)

| Metric | Total | Mean/instance |
|---|---|---|
| Input tokens | 5,608,671 | 623,186 |
| Output tokens | 60,104 | 6,678 |
| Wall-clock (s) | 849 | 94.3 |
| Iterations | 260 | 28.9 |
| Tool calls | 256 | 28.4 |

_Tokens are provider-billed; on a caching provider input tokens are largely cache reads. Not official-harness comparable — see README caveats._
