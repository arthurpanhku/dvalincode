# AI Change Impact Assessment: Claude Code as a remediation executor

## Change Summary

- PR / issue: Claude Code executor for `dvalincode dvalin --fix` / `--until-clean`
- Owner: maintainer (arthurpanhku)
- Date: 2026-10-09
- Change class: A2 (a new executor behind an existing interface; no change to verification)
- Components changed: `src/remediation/executor.ts` (new `claudeCodeExecutor`), `src/commands/dvalin.ts` (accepts `--executor claude-code`, renders executor notices)

## Intended Use

- Workflow: let teams that already use Claude Code have it perform the edits in Dvalin's fix loop, while Dvalin keeps scanning and running checks itself.
- Modes affected: terminal (`dvalincode dvalin`). Not the web UI, TUI or MCP server.
- Default behaviour: unchanged. The default executor is still `dvalin`; Claude Code runs only when `--executor claude-code` is given.

## Stakeholders

- Maintainer: arthurpanhku
- User or organization admin: whoever authorises Claude Code (API key or login) on the machine running Dvalin
- Security reviewer: to be assigned at review
- Affected third-party providers: Anthropic (Claude Code sends prompts and the code it reads to Anthropic's API under the user's own credentials)

## Data and Privacy

- **Sent to a provider:** the remediation prompt (finding rule IDs, file paths, messages, and failing-check output tails), plus whatever files Claude Code reads in the isolated worktree. This is the same class of data the Codex executor sends to OpenAI.
- **Stored by Dvalin:** nothing new. Dvalin keeps the executor's final message in memory for the round and the conversation handle to resume; prompts and responses are not written to Dvalin's audit chain. Claude Code keeps its own transcript under the user's `~/.claude`, outside Dvalin's control.
- **`.dvalincodeignore` and policy:** they apply to Dvalin's scans and checks. They do **not** bind what Claude Code reads. As with Codex, the boundary is the isolated worktree, which holds only the repository.
- **Audit minimisation:** unchanged. The fix record stores `executor: "claude-code"`, and it is recorded, not consulted.

## Autonomy and Permission Impact

- **File writes:** inside the isolated worktree, through `--permission-mode acceptEdits`.
- **Shell:** only inside Claude Code's own sandbox (`sandbox.enabled: true`, `autoAllowBashIfSandboxed: true`, `allowUnsandboxedCommands: false`). Without the sandbox dependencies, Dvalin passes `--disallowedTools Bash`, so the executor can edit but not run anything.
- **Fail-open guard:** Claude Code runs commands unsandboxed, with a warning, when the sandbox cannot start. Verified 2026-10-09 with Claude Code 2.1.295 on Linux without bubblewrap. Dvalin therefore:
  1. checks for the sandbox dependencies before choosing the arguments;
  2. kills the process if the "WITHOUT sandboxing" notice appears on stderr. The notice is printed at startup, before the first tool call.
- **Never used:** `bypassPermissions` and `--dangerously-skip-permissions`. The prompt is passed after `--`, so it cannot be read as a flag.
- **Prompt injection:** the executor may read attacker-influenced code. Its output is never trusted. Dvalin re-scans, runs the checks itself, undoes suppressions, and detects evasion, so a manipulated executor can at worst fail to fix, not cause a false `verified`.

## Model and Supplier Impact

- **New hosted service reached:** Anthropic, via the user-installed `claude` CLI. It is not routed through Dvalin's governed egress path; Claude Code's sandbox network rules and the user's own Claude Code configuration govern it, exactly as the `codex` executor's traffic is governed by Codex.
- **Errors:** an error result (authentication, API, turn limit) or a non-zero exit fails the round with the reason. It is never read as an empty answer.

## Security and Supply Chain

- **Dependencies:** none added. `claude` is an optional, user-installed CLI.
- **CI, CodeQL, Scorecard, release verification:** unchanged.
- **Secrets:** no new secret is required by Dvalin. Claude Code uses the user's own credentials.
- **Session isolation:** when Dvalin runs inside a Claude Code session, the session-binding variables (`CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_REMOTE_SESSION_ID`) are removed. The executor then starts its own conversation instead of joining the caller's. Verified: without removing them, a nested `claude` reported the parent's session ID.

## Testing and Evidence

- **Unit tests** (`tests/remediationClaudeExecutor.test.ts`):
  - stream parsing, including error results;
  - the exact command line in both sandbox states;
  - the prompt-after-`--` rule;
  - environment scrubbing;
  - sandbox detection.
- **Process tests**, with a fake `claude`:
  - a normal turn;
  - the kill on the unsandboxed notice (the fake's side effect never happens);
  - edit-only mode with a notice;
  - an error result fails the turn;
  - an unavailable CLI is reported.
- **Manual verification**, 2026-10-09:
  - real `claude` 2.1.295 drove `--until-clean` on a repository with an `eval` finding;
  - Claude Code replaced `eval` with a parser; its Bash attempt was refused (edit-only mode);
  - Dvalin ran `node test.js` itself, and the fix record verified with `executor: claude-code`.

## Residual Risk

- **Remaining risks:**
  - The unsandboxed-notice guard depends on Claude Code's wording on stderr. If the wording changes, the dependency pre-check still prevents the fail-open case where the dependencies are missing; a sandbox that fails for some other reason would not be caught.
  - In edit-only mode, dependency upgrades that need a package manager cannot be performed by this executor.
- **Accepted exceptions:** Claude Code's file reads inside the worktree are not filtered by `.dvalincodeignore`. The same holds for Codex.
- **Owner:** maintainer
- **Review date:** at the next Claude Code major version, or by 2027-01-09

## Decision

- [ ] Approved
- [ ] Approved with conditions
- [ ] Rejected

Reviewer:
Date:
