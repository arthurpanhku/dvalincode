# Unattended harness recipes

`dvalincode run` is the bounded primitive for schedulers and CI. It never opens
an approval prompt, applies the org policy's `unattended` ceiling when stdin is
not a TTY (or when `--unattended` is explicit), and leaves one audit chain per
turn. Use `--report` to persist a human-readable evidence artifact beside the
harness logs.

Recommended machine or repository policy:

```json
{
  "unattended": {
    "maxPermissionMode": "auto",
    "maxIterations": 40,
    "maxWallMinutes": 30
  }
}
```

An explicitly requested permission mode, iteration limit, or timeout that
exceeds this block fails with exit code 3. Organization provider, model, path,
command, tool, MCP, and network policy continues to apply inside the run.

## Nightly dependency maintenance with cron

Keep the prompt in a reviewed file, create one timestamped report per attempt,
and let cron capture stdout/stderr separately:

```text
15 2 * * * cd /srv/acme-app && mkdir -p reports && dvalincode run --prompt-file ops/nightly-deps.md --permission-mode auto --report "reports/deps-$(date +\%s).md" --output-format json >> reports/deps.jsonl 2>> reports/deps.log
```

Example `ops/nightly-deps.md`:

```text
Check for patch-level dependency updates. Apply only compatible patch updates,
run the focused test suite, and stop without changing files if tests fail.
```

## CI post-merge fixup

The JSON result is emitted even on failure, so the job can archive it and the
report regardless of the exit code:

```sh
set +e
dvalincode run \
  --prompt-file .ci/post-merge-fixup.md \
  --permission-mode auto \
  --timeout 20 \
  --report artifacts/dvalin-report.md \
  --output-format json > artifacts/dvalin-result.json
status=$?
set -e

test "$status" -eq 0
```

Treat exit 2 as bad harness input, exit 3 as a policy mismatch, and exit 4 as a
timeout or interrupt. Exit 1 represents an agent, tool, or provider failure.

## Claude Code `/loop` delegation

Register the task-level stdio server:

```json
{
  "mcpServers": {
    "dvalincode": {
      "command": "dvalincode",
      "args": ["mcp-serve", "--workspace", "/srv/acme-app", "--max-permission-mode", "auto"]
    }
  }
}
```

Then instruct the loop to call `dvalin_run_task` for each code-changing
iteration and `dvalin_get_evidence` afterward. The external agent owns the
schedule; DvalinCode retains the internal model/tool loop and policy
chokepoint. `dvalin_run_task` is synchronous, so configure a caller timeout
longer than its `timeout_minutes` input.
