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
RES="$HERE/results/$ID/$TS"
mkdir -p "$RES" "$WS"

step() { printf '\n=== %s ===\n' "$*"; }

step "1/7 fetch instance"
node "$HERE/fetch-instance.mjs" "$ID"
INST="$HERE/instances/$ID.json"
REPO_GH="$(jq -r .repo "$INST")"
BASE="$(jq -r .base_commit "$INST")"
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
          echo "ERROR: bare test names with $NTESTFILES test files — unsupported" >&2; exit 1
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

step "3/7 python env ($PYTHON)"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
  "$VENV/bin/pip" -q install -U pip setuptools wheel
  "$VENV/bin/pip" -q install "pytest==7.4.4"
fi
(cd "$REPO" && "$VENV/bin/pip" -q install -e .)
"$VENV/bin/python" -c "import sys; print('python:', sys.version.split()[0])"

step "4/7 pre-check: F2P must FAIL with held-out tests applied, at base source"
git -C "$REPO" apply "$WS/test.patch"
set +e
(cd "$REPO" && "$VENV/bin/python" -m pytest -q $F2P) > "$RES/pre-f2p.log" 2>&1
PRE=$?
set -e
# Remove the held-out tests again — the agent must not see them.
for f in $TESTFILES; do git -C "$REPO" checkout -q "$BASE" -- "$f" 2>/dev/null || true; done
if [ "$PRE" -eq 0 ]; then
  echo "ERROR: FAIL_TO_PASS already passes at base source — bad instance or env"; exit 1
fi
echo "ok: F2P fails at base source (pytest exit $PRE)"

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
if [ "$F2P_EXIT" -eq 0 ] && [ "$P2P_EXIT" -eq 0 ]; then RESOLVED=true; else RESOLVED=false; fi
echo "F2P exit: $F2P_EXIT · P2P exit: $P2P_EXIT · resolved: $RESOLVED"

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
  f2p_exit: $F2P_EXIT,
  p2p_exit: $P2P_EXIT,
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
echo "results: $RES"
