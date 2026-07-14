#!/usr/bin/env bash
# SWE-bench Lite smoke harness — run one instance end-to-end:
#   fetch → clone@base_commit → venv → pre-check → agent (Code/bypass) → evaluate → record
# Usage:  bash eval/swebench/run-one.sh sympy__sympy-24152
# Env:    PYTHON=python3.11  AGENT_TIMEOUT_MIN=25
# Caveat: local-venv evaluation, NOT the official Docker harness (see README.md).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ID="${1:?usage: run-one.sh <instance_id>}"
PYTHON="${PYTHON:-python3.11}"
TS="$(date +%Y%m%d-%H%M%S)"
WS="$HERE/workspaces/$ID"
REPO="$WS/repo"
VENV="$WS/venv"
# RESULTS_DIR override lets run-batch.sh collect per-instance results under one
# batch directory; default keeps the standalone results/<id>/<ts>/ layout.
RES="${RESULTS_DIR:-$HERE/results/$ID/$TS}"
mkdir -p "$RES" "$WS"

step() { printf '\n=== %s ===\n' "$*"; }

# ── Structured failure handling ─────────────────────────────────────────────
# Every exit path writes result.json with a `stage` so a batch run can classify
# where each instance failed (env / precheck / agent / eval) instead of dying.
STAGE=init
RESULT_WRITTEN=0
RESULT_JSON="$RES/result.json"
write_result() { # $1=resolved(true|false) $2=stage $3=error
  local resolved="$1" stage="$2" err="${3:-}"
  # Every var the node script reads must be exported here — they are not in the
  # process environment otherwise (ID/TS/RESULT_JSON are plain shell vars).
  RESULT_JSON="$RESULT_JSON" ID="$ID" TS="$TS" \
  RESOLVED="$resolved" STAGE_W="$stage" ERR_W="$err" node -e '
    const fs = require("fs");
    fs.writeFileSync(process.env.RESULT_JSON, JSON.stringify({
      instance_id: process.env.ID,
      dataset: "princeton-nlp/SWE-bench_Lite",
      timestamp: process.env.TS,
      resolved: process.env.RESOLVED === "true",
      stage: process.env.STAGE_W,
      error: process.env.ERR_W || undefined,
      harness: "local-venv smoke (non-official)",
    }, null, 2) + "\n");
  ' || printf '{"instance_id":"%s","resolved":false,"stage":"%s"}\n' "$ID" "$stage" > "$RESULT_JSON"
  RESULT_WRITTEN=1
}
# EXIT trap, not ERR: bash's `set -e` exits on a failing `( subshell )` (e.g. a
# pip build) WITHOUT firing the ERR trap, which would leave no result.json.
# The EXIT trap catches every non-zero exit and records the stage that failed.
on_exit() {
  local code=$?
  [ "$code" -eq 0 ] && return 0
  [ "$RESULT_WRITTEN" -eq 1 ] && return 0
  write_result false "$STAGE" "stage $STAGE failed (exit $code)"
  echo "FAILED at stage=$STAGE (exit $code); wrote $RESULT_JSON" >&2
}
die() { # $1=message $2=stage
  STAGE="${2:-$STAGE}"
  write_result false "$STAGE" "$1"
  echo "SKIP/ERROR: $1 (stage=$STAGE); wrote $RESULT_JSON" >&2
  exit 1
}
# Classify a pytest run: "pass" | "fail" (real assertion failure) | "error"
# (collection/usage/env broken). A broken env exits non-zero just like a real
# failure, so exit code alone can't tell them apart — require a `N failed`
# summary line for a genuine failure. $1=exit code $2=log file.
pytest_outcome() {
  local code="$1" log="$2"
  if [ "$code" -eq 0 ]; then echo pass; return; fi
  if [ "$code" -eq 1 ] && grep -qE '[0-9]+ failed' "$log"; then echo fail; return; fi
  echo error
}
trap on_exit EXIT

STAGE=fetch
step "1/7 fetch instance"
node "$HERE/fetch-instance.mjs" "$ID"
INST="$HERE/instances/$ID.json"
REPO_GH="$(jq -r .repo "$INST")"
BASE="$(jq -r .base_commit "$INST")"
VERSION="$(jq -r '.version // empty' "$INST")"
# Shallow clones carry no tags, so setuptools-scm resolves the package version
# to 0.1.dev1 — which trips pyproject/tox `minversion` gates (pytest self-check
# refused to run). Pretend the instance's real version; harmless for repos that
# don't use setuptools-scm (sympy et al. ignore it).
export SETUPTOOLS_SCM_PRETEND_VERSION="${VERSION:-99.0}"
jq -r .test_patch "$INST" > "$WS/test.patch"
TESTFILES="$(grep '^diff --git' "$WS/test.patch" | awk '{print $3}' | sed 's#^a/##')"
NTESTFILES="$(echo "$TESTFILES" | grep -c . || true)"

# FAIL_TO_PASS / PASS_TO_PASS arrive as JSON-encoded strings from the HF API.
# Entries are either full pytest ids (path::name) or bare test-function names
# (sympy style); bare names are only resolvable when test_patch touches
# exactly one test file.
F2P_RAW="$(jq -r '.FAIL_TO_PASS | if type=="string" then fromjson else . end | .[]' "$INST")"
P2P_RAW="$(jq -r '.PASS_TO_PASS | if type=="string" then fromjson else . end | .[]' "$INST")"
resolve_ids() {
  local raw="$1" out="" t
  for t in $raw; do
    case "$t" in
      *::*) out="$out $t" ;;
      *)
        if [ "$NTESTFILES" -ne 1 ]; then
          die "bare test names with $NTESTFILES test files — unsupported" resolve_unsupported
        fi
        out="$out $TESTFILES::$t"
        ;;
    esac
  done
  echo "$out"
}
F2P="$(resolve_ids "$F2P_RAW")"
P2P="$(resolve_ids "$P2P_RAW")"
echo "F2P:$F2P"

STAGE=workspace
step "2/7 workspace: $REPO_GH @ ${BASE:0:12}"
if [ ! -d "$REPO/.git" ]; then
  mkdir -p "$REPO"
  git -C "$REPO" init -q
  git -C "$REPO" remote add origin "https://github.com/$REPO_GH.git"
  git -C "$REPO" fetch -q --depth 1 origin "$BASE"
  git -C "$REPO" checkout -q -b swebench-base FETCH_HEAD
  git -C "$REPO" config user.email swebench@local
  git -C "$REPO" config user.name swebench
else
  git -C "$REPO" reset --hard -q "$BASE"
  git -C "$REPO" clean -fdq
fi

STAGE=env
step "3/7 python env ($PYTHON)"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
  # setuptools >= 81 dropped the bundled `pkg_resources`, which pre-2023 repos
  # (sphinx.testing, old pytest) still import → ImportError at collection. Pin
  # an older setuptools that still ships it; harmless for repos that don't use it.
  "$VENV/bin/pip" -q install -U pip wheel "setuptools<81"
  "$VENV/bin/pip" -q install "pytest==7.4.4"
fi
# In docker-eval mode (SKIP_PRECHECK=1) a broken venv is fine — the official
# harness grades the patch (Phase 2), so let the agent run even if the editable
# install fails here. Default mode still treats it as a hard env failure.
if ! (cd "$REPO" && "$VENV/bin/pip" -q install -e .); then
  [ "${SKIP_PRECHECK:-0}" = 1 ] || die "editable install failed" env
  echo "warn: editable install failed; agent runs without a working venv (Phase 2 Docker will grade)"
fi
"$VENV/bin/python" -c "import sys; print('python:', sys.version.split()[0])"

STAGE=precheck
if [ "${SKIP_PRECHECK:-0}" = 1 ]; then
  step "4/7 pre-check: SKIPPED (docker-eval mode — official Docker harness grades at base)"
else
  step "4/7 pre-check: F2P must FAIL with held-out tests applied, at base source"
  git -C "$REPO" apply "$WS/test.patch"
  set +e
  (cd "$REPO" && "$VENV/bin/python" -m pytest -q $F2P) > "$RES/pre-f2p.log" 2>&1
  PRE=$?
  set -e
  # Remove the held-out tests again — the agent must not see them.
  for f in $TESTFILES; do git -C "$REPO" checkout -q "$BASE" -- "$f" 2>/dev/null || true; done
  PRE_OUTCOME="$(pytest_outcome "$PRE" "$RES/pre-f2p.log")"
  if [ "$PRE_OUTCOME" = "pass" ]; then
    die "FAIL_TO_PASS already passes at base source — bad instance or env drift" precheck_unexpected
  fi
  if [ "$PRE_OUTCOME" = "error" ]; then
    # Collection/usage/dependency error — the test never ran, so this instance
    # can't measure the agent. Skip before burning agent tokens on a dead env.
    die "F2P did not execute at base (pytest exit $PRE — collection/env broken)" env_broken_at_test
  fi
  echo "ok: F2P fails at base source (pytest exit $PRE)"
fi

STAGE=agent
step "5/7 agent run (Code mode / bypass; provider from ~/.dvalincode/config.json)"
jq -r .problem_statement "$INST" > "$WS/issue.txt"
{
  echo "Fix the following GitHub issue in this repository (the current working directory)."
  echo
  echo "Requirements:"
  echo "- Modify the SOURCE code only. Do NOT modify or create any test files."
  echo "- Keep the change minimal and focused on the root cause."
  echo "- A Python environment for this repo is at: $VENV/bin/python (pytest installed)."
  echo "  Validate with: $VENV/bin/python -m pytest <relevant test paths>"
  echo "- When the fix is validated, summarize what you changed."
  echo
  echo "<issue>"
  cat "$WS/issue.txt"
  echo "</issue>"
} > "$WS/prompt.txt"
cp "$WS/prompt.txt" "$RES/prompt.txt"

AGENT_TIMEOUT_MIN="${AGENT_TIMEOUT_MIN:-25}" \
  node "$HERE/agent-driver.mjs" "$REPO" "$WS/prompt.txt" "$RES/agent.json" 2>&1 | tee "$RES/agent.log"

STAGE=evaluate
step "6/7 evaluate"
git -C "$REPO" add -A
git -C "$REPO" diff --cached > "$RES/agent.diff"

AGENT_TOUCHED_TESTS=false
for f in $TESTFILES; do
  if git -C "$REPO" diff --cached --name-only | grep -qx "$f"; then AGENT_TOUCHED_TESTS=true; fi
  git -C "$REPO" checkout -q "$BASE" -- "$f" 2>/dev/null || true
done
git -C "$REPO" apply "$WS/test.patch"

set +e
(cd "$REPO" && "$VENV/bin/python" -m pytest -q $F2P) > "$RES/f2p.log" 2>&1; F2P_EXIT=$?
(cd "$REPO" && "$VENV/bin/python" -m pytest -q $P2P) > "$RES/p2p.log" 2>&1; P2P_EXIT=$?
set -e
F2P_OUTCOME="$(pytest_outcome "$F2P_EXIT" "$RES/f2p.log")"
P2P_OUTCOME="$(pytest_outcome "$P2P_EXIT" "$RES/p2p.log")"
if [ "$F2P_EXIT" -eq 0 ] && [ "$P2P_EXIT" -eq 0 ]; then RESOLVED=true; else RESOLVED=false; fi
echo "F2P: $F2P_OUTCOME (exit $F2P_EXIT) · P2P: $P2P_OUTCOME (exit $P2P_EXIT) · resolved: $RESOLVED"

STAGE=record
step "7/7 record"
PYVER="$("$VENV/bin/python" -V 2>&1)"
node -e "
const fs = require('fs');
const agent = JSON.parse(fs.readFileSync('$RES/agent.json', 'utf8'));
const result = {
  instance_id: '$ID',
  dataset: 'princeton-nlp/SWE-bench_Lite',
  timestamp: '$TS',
  resolved: $RESOLVED,
  stage: 'done',
  f2p_exit: $F2P_EXIT,
  p2p_exit: $P2P_EXIT,
  f2p_outcome: '$F2P_OUTCOME',
  p2p_outcome: '$P2P_OUTCOME',
  agent_touched_tests: $AGENT_TOUCHED_TESTS,
  harness: 'local-venv smoke (non-official)',
  python: '$PYVER',
  agent,
};
fs.writeFileSync('$RES/result.json', JSON.stringify(result, null, 2));
if (agent.reportMarkdown) fs.writeFileSync('$RES/report.md', agent.reportMarkdown);
const s = { resolved: result.resolved, model: agent.model, iterations: agent.iterationsUsed,
  toolCalls: agent.toolCalls, wallSeconds: agent.wallSeconds, tokens: agent.usage, runId: agent.runId };
console.log(JSON.stringify(s, null, 2));
"
RESULT_WRITTEN=1
echo "results: $RES"
