# Batch summary — `20260714-104231`

Generated 2026-07-14T03:13:32.781Z · harness: local-venv smoke (non-official).

## Headline

- **Resolved: 5/30 (16.7%)**
- Model(s): `deepseek-coder`
- Agent ran on 16/30 instances (rest failed before the agent).

## Outcome / failure classification

| Bucket | Count | Share |
|---|---|---|
| `env_broken_at_test` | 13 | 43.3% |
| `unresolved_fix_failed` | 11 | 36.7% |
| `resolved` | 5 | 16.7% |
| `env` | 1 | 3.3% |

Buckets: `resolved` (F2P+P2P pass) · `unresolved_fix_failed` (target test still fails) · `p2p_regression` (fix works but breaks held-out tests) · `eval_error` (test errored at eval — env/collection, not an agent miss) · `env` (venv/pip build) · `env_broken_at_test` (test never ran at base — dep/collection error) · `precheck*` (bad instance/env drift) · `resolve_unsupported` (test-id mapping) · `agent` (agent crash) · `instance_timeout` · `harness_error`.

## Per-repo resolved rate

| Repo | Resolved | Rate |
|---|---|---|
| sympy | 4/20 | 20.0% |
| sphinx-doc | 1/5 | 20.0% |
| pylint-dev | 0/2 | 0.0% |
| pytest-dev | 0/2 | 0.0% |
| psf | 0/1 | 0.0% |

## Cost & latency (agent instances only)

| Metric | Total | Mean/instance |
|---|---|---|
| Input tokens | 8,072,511 | 504,532 |
| Output tokens | 105,326 | 6,583 |
| Wall-clock (s) | 1311 | 82.0 |
| Iterations | 359 | 22.4 |
| Tool calls | 374 | 23.4 |

_Tokens are provider-billed; on a caching provider input tokens are largely cache reads. Not official-harness comparable — see README caveats._
