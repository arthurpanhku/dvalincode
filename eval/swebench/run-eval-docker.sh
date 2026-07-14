#!/usr/bin/env bash
# Phase 2 — official SWE-bench Docker evaluation of a batch's agent patches.
#
# The local-venv harness (run-one/run-batch) grades patches in a python3.11
# venv, which cannot reproduce each repo's intended environment — 40-60% of
# Lite instances can't even run their tests there (see results/FINDINGS.md).
# This script hands the agent's patches to the OFFICIAL SWE-bench harness,
# which builds a per-instance Docker image with the correct interpreter and
# frozen dependencies and returns a resolved verdict that IS comparable to
# published SWE-bench Lite numbers.
#
# The agent itself still ran on the host under full governance (seatbelt
# sandbox + audit chain); only the *grading* moves into Docker. So this
# measures the governance tax against a faithful denominator.
#
# Usage:
#   bash eval/swebench/run-eval-docker.sh <batch-dir>
#        [--run-id ID] [--max-workers N] [--dataset NAME]
# Env:
#   PYTHON=python3.11         interpreter used to bootstrap the swebench tool venv
#   SWEBENCH_PY=/path/python  use an existing python that already has swebench
#                             (skips the tool-venv bootstrap)
#   MODEL_NAME=dvalincode     model_name_or_path recorded in predictions
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3.11}"

BATCH="${1:?usage: run-eval-docker.sh <batch-dir> [--run-id ID] [--max-workers N]}"
shift || true
[ -d "$BATCH" ] || { echo "batch dir not found: $BATCH" >&2; exit 1; }
BATCH="$(cd "$BATCH" && pwd)"   # absolute — the harness runs from inside it

RUN_ID="dvalincode-$(basename "$BATCH")"
WORKERS=4
DATASET="princeton-nlp/SWE-bench_Lite"
while [ $# -gt 0 ]; do
  case "$1" in
    --run-id)      RUN_ID="$2"; shift 2 ;;
    --max-workers) WORKERS="$2"; shift 2 ;;
    --dataset)     DATASET="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n=== %s ===\n' "$*"; }

# ── Preflight: fail fast with actionable messages ───────────────────────────
step "preflight"
command -v docker >/dev/null 2>&1 || { echo "docker not found — install Docker and start the daemon" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker daemon not reachable — start Docker Desktop / dockerd" >&2; exit 1; }

# swebench interpreter: an existing one (SWEBENCH_PY) or a cached tool venv,
# mirroring fetch-dataset.mjs's .venv-tools pattern.
if [ -n "${SWEBENCH_PY:-}" ]; then
  PY="$SWEBENCH_PY"
else
  VENV="$HERE/.venv-tools"
  PY="$VENV/bin/python"
  if [ ! -x "$PY" ] || ! "$PY" -c "import swebench" 2>/dev/null; then
    echo "provisioning tool venv (swebench)…"
    [ -x "$PY" ] || "$PYTHON" -m venv "$VENV"
    "$PY" -m pip -q install -U pip
    "$PY" -m pip -q install swebench
  fi
fi
"$PY" -c "import swebench" 2>/dev/null || { echo "swebench not importable via $PY — run: $PY -m pip install swebench" >&2; exit 1; }
echo "docker:   $(docker --version)"
echo "swebench: $("$PY" -c 'import importlib.metadata as m; print(m.version("swebench"))' 2>/dev/null || echo '?') via $PY"

# ── Predictions from the batch's agent patches ──────────────────────────────
step "collect predictions"
PRED="$BATCH/predictions.jsonl"
MODEL_NAME="${MODEL_NAME:-dvalincode}" node "$HERE/predictions.mjs" "$BATCH" "$PRED"

# ── Official evaluation (per-instance Docker images) ────────────────────────
step "swebench.harness.run_evaluation  ·  run_id=$RUN_ID  ·  workers=$WORKERS"
# Run from inside the batch dir so the report json + logs/ land there (the
# harness writes <model_name_or_path>.<run_id>.json into the current directory).
( cd "$BATCH" && "$PY" -m swebench.harness.run_evaluation \
    --dataset_name "$DATASET" \
    --predictions_path "$PRED" \
    --max_workers "$WORKERS" \
    --run_id "$RUN_ID" )

REPORT="$(ls -t "$BATCH"/*."$RUN_ID".json 2>/dev/null | head -1 || true)"
[ -n "$REPORT" ] || { echo "eval finished but no report json (*.$RUN_ID.json) found under $BATCH" >&2; exit 1; }
echo "official report: $REPORT"

# ── Summarize: official verdict × on-host governance/cost metrics ───────────
step "summarize"
node "$HERE/summarize-official.mjs" "$BATCH" "$REPORT"
