#!/usr/bin/env bash
# Batch runner over the SWE-bench Lite runnable subset.
#   - selects instances from instances/_lite.json (runnable only)
#   - runs each through run-one.sh into results/batches/<ts>/<instance_id>/
#   - resumable: instances that already have a result.json are skipped
#   - per-instance wall timeout (needs `timeout`/`gtimeout`; else agent-internal)
#   - summarizes at the end (summarize.mjs)
#
# Usage:
#   bash eval/swebench/run-batch.sh [--repo sympy] [--limit N] [--sample N]
#                                   [--resume results/batches/<ts>] [--ids a,b,c]
#                                   [--tier friendly|heavy|old-python] [--no-precheck]
#   --no-precheck: skip the local venv gate so the agent runs on every instance;
#                  grade the patches faithfully with run-eval-docker.sh (Phase 2).
# Env: PYTHON=python3.11  AGENT_TIMEOUT_MIN=15  AGENT_MAX_ITERATIONS=25  INSTANCE_TIMEOUT_MIN=20
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$HERE/instances/_lite.json"
PYTHON="${PYTHON:-python3.11}"
AGENT_TIMEOUT_MIN="${AGENT_TIMEOUT_MIN:-15}"
AGENT_MAX_ITERATIONS="${AGENT_MAX_ITERATIONS:-25}"
INSTANCE_TIMEOUT_MIN="${INSTANCE_TIMEOUT_MIN:-20}"

REPO_FILTER="" LIMIT="" SAMPLE="" RESUME="" IDS="" TIER="" NOPRE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)   REPO_FILTER="$2"; shift 2 ;;
    --limit)  LIMIT="$2"; shift 2 ;;
    --sample) SAMPLE="$2"; shift 2 ;;
    --resume) RESUME="$2"; shift 2 ;;
    --ids)    IDS="$2"; shift 2 ;;
    --tier)   TIER="$2"; shift 2 ;;   # friendly | heavy | old-python
    --no-precheck) NOPRE=1; shift ;;  # skip venv precheck; grade via run-eval-docker.sh (Phase 2)
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -f "$MANIFEST" ] || { echo "missing $MANIFEST — run: node $HERE/fetch-dataset.mjs" >&2; exit 1; }

if [ -n "$RESUME" ]; then
  BATCH="$RESUME"
  [ -d "$BATCH" ] || { echo "resume dir not found: $BATCH" >&2; exit 1; }
  echo "resuming batch: $BATCH"
else
  BATCH="$HERE/results/batches/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BATCH"
fi

# Resolve the instance list (node handles the nested manifest JSON).
# `while read` (not mapfile) so this works on macOS's stock bash 3.2.
INSTANCES=()
while IFS= read -r line; do
  [ -n "$line" ] && INSTANCES+=("$line")
done < <(
  REPO_FILTER="$REPO_FILTER" LIMIT="$LIMIT" SAMPLE="$SAMPLE" IDS="$IDS" TIER="$TIER" \
  node -e '
    const fs = require("fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    let list = m.instances.filter((i) => i.runnable);
    const { REPO_FILTER, LIMIT, SAMPLE, IDS, TIER } = process.env;
    // Environment tier under the local python3.11 venv (repo + version based):
    // heavy = C-extension builds that fail on 3.11; old-python = pytest < 7
    // (AST/pkg_resources incompatibilities); friendly = pure-python, runs on 3.11.
    const heavy = new Set(["matplotlib/matplotlib", "scikit-learn/scikit-learn", "astropy/astropy", "mwaskom/seaborn"]);
    const tierOf = (i) => heavy.has(i.repo) ? "heavy"
      : (i.repo === "pytest-dev/pytest" && parseFloat(i.version) < 7) ? "old-python"
      : "friendly";
    if (TIER) list = list.filter((i) => tierOf(i) === TIER);
    if (IDS) {
      const want = new Set(IDS.split(",").map((s) => s.trim()).filter(Boolean));
      list = list.filter((i) => want.has(i.instance_id));
    }
    if (REPO_FILTER) list = list.filter((i) => i.repo.includes(REPO_FILTER));
    if (SAMPLE) {
      for (let k = list.length - 1; k > 0; k--) {
        const j = Math.floor(Math.random() * (k + 1));
        [list[k], list[j]] = [list[j], list[k]];
      }
      list = list.slice(0, Number(SAMPLE));
    }
    if (LIMIT) list = list.slice(0, Number(LIMIT));
    for (const i of list) console.log(i.instance_id);
  ' "$MANIFEST"
)

TOTAL=${#INSTANCES[@]}
[ "$TOTAL" -gt 0 ] || { echo "no instances selected" >&2; exit 1; }

# Portable per-instance wall timeout. macOS has no timeout(1), so run the
# instance in its own process group (job control) and kill the whole group if
# it overruns — this also bounds env/pip build steps the agent-internal timeout
# doesn't cover. Returns 124 on timeout, else run-one.sh's exit code.
INSTANCE_TIMEOUT_SEC=$((INSTANCE_TIMEOUT_MIN * 60))
run_instance() { # $1=instance_id $2=results_dir
  local id="$1" res="$2" pid waited=0 rc=0
  set -m
  (
    RESULTS_DIR="$res" PYTHON="$PYTHON" AGENT_TIMEOUT_MIN="$AGENT_TIMEOUT_MIN" AGENT_MAX_ITERATIONS="$AGENT_MAX_ITERATIONS" \
      SKIP_PRECHECK="$NOPRE" \
      bash "$HERE/run-one.sh" "$id" > "$res/run.log" 2>&1
  ) &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    sleep 5
    waited=$((waited + 5))
    if [ "$waited" -ge "$INSTANCE_TIMEOUT_SEC" ]; then
      kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      sleep 3
      kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
      rc=124
      break
    fi
  done
  if [ "$rc" -eq 0 ]; then wait "$pid"; rc=$?; fi
  set +m
  return "$rc"
}

echo "batch: $BATCH"
echo "selected $TOTAL instance(s); agent max ${AGENT_MAX_ITERATIONS} iterations, timeout ${AGENT_TIMEOUT_MIN}m, instance timeout ${INSTANCE_TIMEOUT_MIN}m"
[ "$NOPRE" -eq 1 ] && echo "local precheck/evaluation disabled; patches await official Docker grading"
echo

n=0; ran=0; skipped=0
for ID in "${INSTANCES[@]}"; do
  n=$((n + 1))
  RES="$BATCH/$ID"
  if [ -f "$RES/result.json" ]; then
    skipped=$((skipped + 1))
    echo "[$n/$TOTAL] skip $ID (already has result.json)"
    continue
  fi
  mkdir -p "$RES"
  echo "[$n/$TOTAL] run $ID"
  set +e
  run_instance "$ID" "$RES"
  code=$?
  set -e
  ran=$((ran + 1))
  # A timeout (124) or crash without result.json: synthesize one so the batch
  # stays complete and summarize can classify it.
  if [ ! -f "$RES/result.json" ]; then
    STAGE_GUESS="harness_error"; [ "$code" -eq 124 ] && STAGE_GUESS="instance_timeout"
    ID="$ID" STAGE_GUESS="$STAGE_GUESS" CODE="$code" RESULT="$RES/result.json" node -e '
      require("fs").writeFileSync(process.env.RESULT, JSON.stringify({
        instance_id: process.env.ID, resolved: false, stage: process.env.STAGE_GUESS,
        error: `run-one.sh exited ${process.env.CODE} without result.json`,
        harness: "local-venv smoke (non-official)",
      }, null, 2) + "\n");
    '
  fi
  VERDICT=$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((r.resolved?"RESOLVED":"unresolved")+" stage="+(r.stage||"?"))' "$RES/result.json" 2>/dev/null || echo "unknown")
  echo "      → $VERDICT (exit $code)"
done

echo
echo "ran $ran, skipped $skipped of $TOTAL"
node "$HERE/summarize.mjs" "$BATCH"
