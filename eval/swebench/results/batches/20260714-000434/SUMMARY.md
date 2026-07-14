# Batch summary — `20260714-000434`

Generated 2026-07-14T02:37:36.264Z · harness: local-venv smoke (non-official).

## Headline

- **Resolved: 2/15 (13.3%)**
- Model(s): `deepseek-coder`
- Agent ran on 5/15 instances (rest failed before the agent).

## Outcome / failure classification

| Bucket | Count | Share |
|---|---|---|
| `env` | 5 | 33.3% |
| `env_broken_at_test` | 4 | 26.7% |
| `unresolved_fix_failed` | 3 | 20.0% |
| `resolved` | 2 | 13.3% |
| `evaluate` | 1 | 6.7% |

Buckets: `resolved` (F2P+P2P pass) · `unresolved_fix_failed` (target test still fails) · `p2p_regression` (fix works but breaks held-out tests) · `eval_error` (test errored at eval — env/collection, not an agent miss) · `env` (venv/pip build) · `env_broken_at_test` (test never ran at base — dep/collection error) · `precheck*` (bad instance/env drift) · `resolve_unsupported` (test-id mapping) · `agent` (agent crash) · `instance_timeout` · `harness_error`.

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
| Input tokens | 2,596,222 | 519,244 |
| Output tokens | 32,319 | 6,464 |
| Wall-clock (s) | 451 | 90.1 |
| Iterations | 131 | 26.2 |
| Tool calls | 132 | 26.4 |

_Tokens are provider-billed; on a caching provider input tokens are largely cache reads. Not official-harness comparable — see README caveats._
