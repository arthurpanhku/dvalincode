# Governed Network v1 Threat Model

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

With `network: on`, current behavior is preserved. macOS continues to use its
existing default Seatbelt wrapper when available; other platforms may run the
child without a network sandbox.

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
| Trust report | States the actual provider and shell enforcement status for this platform |

## Non-goals

- Containing arbitrary third-party in-process code.
- Remote MCP, OAuth, or dynamic client registration.
- Host allowlists beyond the configured provider origin.
- Network policy for processes DvalinCode did not launch.
- Claiming transport confidentiality for a configured plain-HTTP endpoint.
- Claiming tamper-proof audit custody against a hostile local administrator.
