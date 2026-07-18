# Governed Network v1 Threat Model

> Part of the runtime's overall [Threat Model](THREAT-MODEL.md) — this doc is the
> deep-dive for attack surface §4 (data exfiltration / uncontrolled egress).

## Scope

Governed Network v1 connects the existing resolved policy to the two network
boundaries that already exist:

1. OpenAI-compatible provider HTTP requests.
2. Agent-launched subprocesses from the `shell` and `run_check` tools.

The goal is a small, demonstrable vertical slice. This version does not add
remote MCP, OAuth, a general proxy, or a second policy engine.

## Policy Semantics

The existing `network` field remains unchanged:

| Value | Provider HTTP | Agent-managed subprocess |
|-------|---------------|------------------|
| `on` | Allowed | Existing platform behavior |
| `endpoint-only` | Only the configured model endpoint | Runs only with OS-enforced network isolation |
| `off` | Blocked | Runs only with OS-enforced network isolation |

`network` remains the enum `off | endpoint-only | on`. Governed Network v1
does not migrate it to an object and does not introduce a host allowlist.
Provider requests reuse `checkEgress(policy, true)`. Shell isolation decisions
reuse `checkEgress(policy, false)`.

Machine and repository policies continue to resolve by narrowing:

`off` is stricter than `endpoint-only`, which is stricter than `on`.

The canonical resolved-policy hash is unchanged. A future detailed network
rule must be an additional restriction whose merge operation is intersection
or another monotonic narrowing operation. It must not reinterpret or widen the
existing enum.

## Enforcement Boundaries

### Provider HTTP

The provider adapter validates egress before sending a request. With
`endpoint-only`, the request origin must match the configured provider origin.
Redirects are handled manually and revalidated before the next request.

This control is **enforced in process** for HTTP requests made by the bundled
provider adapter.

It does not claim to provide process-wide socket containment. In particular,
it does not defend against a malicious provider adapter that bypasses the
bundled request path, DNS rebinding after validation, or another library that
opens a socket directly.

> **Forward guardrail.** Coverage is complete today only because every provider
> funnels through the bundled OpenAI-compatible adapter and its
> `governedProviderFetch`. Any future adapter (native Anthropic, a Responses
> API, Bedrock, etc.) **must** route its outbound HTTP through
> `governedProviderFetch` as well. An adapter that calls `fetch` directly is a
> new, ungoverned egress path and must be treated as a release blocker.

### Agent-launched subprocesses

A subprocess launch is not itself treated as network egress. When policy denies
non-model egress, DvalinCode may still run the command if the child process is
started inside an OS-enforced network-isolation boundary.

| Platform | Mechanism | Restricted-policy status |
|----------|-----------|--------------------------|
| macOS | `/usr/bin/sandbox-exec` with `(deny network*)` | `enforced` when available; otherwise launch is blocked |
| Linux | Bubblewrap with `--unshare-net` | `enforced` when available; otherwise launch is blocked |
| Windows | No v1 mechanism | `unavailable`; launch is blocked |
| Other | No v1 mechanism | `unavailable`; launch is blocked |

There is no advisory fallback for `off` or `endpoint-only`. If DvalinCode
cannot establish the required isolation, it fails closed before launching the
requested command.

With `network: on`, macOS continues to wrap both `shell` and `run_check` in
Seatbelt when available (network denied in the child even though policy permits
egress). Other platforms may run the child without a network sandbox. Under
`endpoint-only` or `off`, both tools are isolated or fail closed identically.

### Remediation subprocesses (v0.9.0)

The secure-remediation workflow (`run_security_scan`,
`prepare_remediation_worktree`, and the `remediation/*` modules) is characterised
here so it stays inside the governance boundary as it grows:

- **`run_security_scan` / local scan** — pure in-process pattern matching
  (`remediation/localScan.ts`). No subprocess, no network. The `helpUri` values
  (CWE references) are strings carried in findings, never fetched.
- **`prepare_remediation_worktree`** — runs exactly two local git commands via
  `execFile` with fixed argv (`git rev-parse --show-toplevel`, `git worktree
  add`), never a shell. Targets are constrained to
  `~/.dvalincode/projects/remediations` via `assertInsidePath` + `realpath`. It
  creates a worktree; it does **not** apply fixes or run untrusted commands.
- **Applying the fix** — the actual edits happen when the agent works inside the
  returned worktree using the normal tools (`edit_file`, `shell`, …). Those
  already pass through the single `registry.run` policy + audit chokepoint, with
  `shell` under the OS network sandbox described above. There is therefore **no
  ungoverned fix-execution path today.**

**Known exemption.** The two git commands in `remediation/worktree.ts` are
launched with a direct `execFile`, not `runGovernedProcess`, so they are not
wrapped in the network-isolation sandbox. They are local git operations (no
fetch), so the practical egress surface is negligible — but this is an explicit,
documented exemption, not an enforced control. Routing them through
`runGovernedProcess` as-is would fail under a restricted policy: the
Seatbelt/Bubblewrap profile grants file-write only to the workspace `cwd` (plus
`/tmp`, `/var`), whereas the worktree is written under `~/.dvalincode`. Governing
these calls therefore requires teaching the sandbox profile about the
remediation directory first.

> **Forward guardrail.** The moment remediation gains a step that *applies a fix
> or runs a command on the user's behalf* (auto-apply, a fixer subprocess, a
> post-fix build/test), that step **must** run through `runGovernedProcess`
> (network sandbox + `checkEgress`) and be audited — never a direct
> `execFile`/`spawn`. Such a subprocess added outside the governed path is a new
> ungoverned execution + egress path and must be treated as a release blocker,
> exactly like an ungoverned provider adapter.

### Self-update egress

The updater paths — the `dvalincode update` command (`commands/update.ts` +
`core/selfUpdate.ts`) and the desktop GUI updater (`gui/updater.ts` +
`core/guiUpdate.ts`) — make outbound HTTPS requests with a direct `fetch`,
**outside** `governedProviderFetch` and outside any run's egress policy. They
are characterised here so this stays a documented channel, not a silent gap:

- **Pinned destinations.** Release metadata comes only from `api.github.com`
  and assets only from `github.com` (`RELEASE_HOSTS` in `core/selfUpdate.ts`);
  the GUI updater additionally rejects any asset URL whose protocol, hostname,
  or release-path prefix does not match the expected GitHub release
  (`assertTrustedGuiAssetUrl`). There is no configurable update source.
- **Integrity before install.** Downloaded archives are verified against the
  release's `SHA256SUMS.txt` before anything is swapped in place; a checksum
  mismatch aborts the update.
- **User-initiated, user-confirmed.** The CLI path runs only on an explicit
  `dvalincode update`; the GUI path installs only after the user confirms a
  native dialog. Nothing downloads or installs silently in the background.

**Known exemption.** Because these requests bypass the governed fetch, a
`network: off` policy does not block an explicit update. This is deliberate
bootstrap-channel egress — the updater must work even when (indeed, especially
when) run policy is restrictive — but it is an explicit, documented exemption,
not an enforced control.

> **Forward guardrail.** The update channel must stay exactly this narrow:
> hosts pinned in code to GitHub releases, checksum verification mandatory,
> and installation always behind an explicit user action. Adding a
> configurable update URL, an unpinned host, or any automatic
> download-and-install without user confirmation is a new ungoverned egress
> path and must be treated as a release blocker.

## Audit Data Policy

Audit data is minimized before persistence:

- User task text is replaced by byte length and SHA-256.
- Tool arguments are summarized by safe structural metadata and SHA-256.
- Shell arguments are not stored; the executable, argument count, and input
  hash are recorded.
- Provider events record provider/model, endpoint origin, outcome, HTTP status,
  and duration. Prompts, response bodies, headers, API keys, paths, and query
  strings are not recorded.

This is a data-minimization guarantee. Any later secret scanner is
best-effort defense in depth and must not be described as complete redaction.

## Acceptance Matrix

| Case | Expected result |
|------|-----------------|
| No policy file | Provider calls behave as before; `network` resolves to `on` |
| Configured provider with `endpoint-only` | Request is sent to the configured origin |
| Provider with `off` | Request is blocked before `fetch` |
| Cross-origin provider redirect with `endpoint-only` | Redirect is blocked before the second request |
| Provider request with `on` | Configured endpoint and redirects are allowed |
| `shell` or `run_check` with `endpoint-only` or `off` on supported macOS | Child starts under Seatbelt with network denied |
| `shell` or `run_check` with `endpoint-only` or `off` on Linux with Bubblewrap | Child starts in an unshared network namespace |
| Agent subprocess with restricted policy and no supported sandbox | Child is not started and a policy violation is recorded |
| Audit log for a provider call | Contains no prompt, response body, headers, API key, path, or query |
| Audit log for a tool call | Contains no file content, replacement text, memory content, or shell arguments |
| Policy resolution | Existing narrowing tests and canonical hash behavior remain unchanged |
| Trust report | States the actual provider, shell, and run_check enforcement status for this platform |
| `run_security_scan` local scan | Runs fully in-process; performs no subprocess and no network I/O |
| `prepare_remediation_worktree` | Runs only fixed-argv local git; writes only inside `~/.dvalincode/projects/remediations`; applies no fix |
| Future remediation fix-execution step | Routed through `runGovernedProcess` and audited; a direct `execFile`/`spawn` is a release blocker |
| `dvalincode update` / GUI update | Contacts only `api.github.com` + `github.com`; installs only after checksum verification and explicit user confirmation |

## Non-goals

- Containing arbitrary third-party in-process code.
- Remote MCP, OAuth, or dynamic client registration.
- Host allowlists beyond the configured provider origin.
- Network policy for processes DvalinCode did not launch.
- Network isolation for the two local git commands in `remediation/worktree.ts`
  (a documented exemption — local git only — pending sandbox-profile support for
  the remediation directory).
- Blocking the user-initiated self-update channel under `network: off` (a
  documented exemption — GitHub-pinned, checksum-verified, user-confirmed; see
  "Self-update egress").
- Claiming transport confidentiality for a configured plain-HTTP endpoint.
- Claiming tamper-proof audit custody against a hostile local administrator.
