# Provider Conformance Profile v1 (PCP-1)

**Status:** draft · **Version:** 1.0.0-draft.1 · **Machine-readable:**
[`docs/spec/provider-conformance-v1.json`](https://github.com/arthurpanhku/dvalincode/blob/main/docs/spec/provider-conformance-v1.json) ·
**License:** MIT, same as the project — copy it, fork it, implement it, no permission needed.

## Scope

Every model provider an AI coding agent talks to is an **egress destination that
receives source code**. Whether that is safe depends almost entirely on the
adapter layer: how the request is routed, what it carries, what happens on a
redirect, and what is recorded afterwards. Today each runtime answers those
questions differently, informally, and usually only in prose — so "can we add
this provider?" is re-litigated as a judgement call every time.

PCP-1 is an attempt to make that question **objective and checkable**: a list of
assertions a provider adapter either satisfies or does not, written so that any
agent runtime — not only DvalinCode — can run them against its own adapters and
publish the result.

This document specifies:

- the assertions (§3–§7), each with a test procedure and pass criteria;
- how a suite implementing them must behave (§8);
- two conformance levels and what may be claimed (§9);
- a report format so results are comparable across implementations (§10).

It does **not** specify an adapter API, a wire format, a policy language, or an
audit format. It constrains observable behavior only. An implementation with a
completely different architecture can be conformant.

### Audience

Agent runtime authors; security reviewers evaluating an agent; model vendors who
want their endpoint to be addable to a governed agent without a bespoke review.

### Conventions

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted
as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Assertion IDs
are stable across patch and minor versions of this profile; an assertion is never
renumbered, only deprecated.

## 1. Terms

| Term | Meaning |
|---|---|
| **Adapter** | The component that turns a runtime-internal chat request into provider protocol traffic and back. |
| **Chokepoint** | The single function all adapter network I/O passes through. |
| **Configured endpoint** | The base URL the operator configured for this provider. Its origin is the *only* origin the adapter is entitled to reach by default. |
| **Governing policy** | The resolved, machine- or organization-level rules in force for the current run. |
| **Audit record** | An entry in the runtime's tamper-evident run log. |
| **Bypass test** | A test that fails when the control it covers is removed. Its purpose is to prevent silent regression, not to demonstrate the happy path. |

## 2. The narrowing rule

> **No assertion in this profile may be satisfied by weakening a control, and no
> configuration option may relax an assertion at runtime.**

A profile that can be satisfied by turning something off is worthless as a gate.
Concretely: if an implementation offers a flag that disables destination
validation, policy consultation, or auditing, that implementation is
**non-conformant** regardless of its default value. Escape hatches for local
development are acceptable only where this profile explicitly permits them
(EG-7), and MUST be visible in the run's recorded posture.

## 3. Egress containment (EG)

| ID | Level | Assertion |
|---|---|---|
| **EG-1** | MUST | All provider network I/O passes through a single chokepoint. No adapter calls the platform HTTP client directly. |
| **EG-2** | MUST | The destination is validated **before** each request is issued. An origin other than the configured endpoint is reachable only when the governing policy explicitly permits non-endpoint egress. |
| **EG-3** | MUST | Redirects are followed manually, and **every hop** is re-validated (EG-2, EG-5–EG-7) and re-authorized (PO-2). Delegating redirect following to the HTTP client is non-conformant. |
| **EG-4** | MUST | The redirect chain is bounded; exceeding the bound raises an error rather than silently returning the last response. |
| **EG-5** | MUST | Schemes other than `http`/`https` are rejected. |
| **EG-6** | MUST | URLs carrying embedded credentials (`user:pass@host`) are rejected. |
| **EG-7** | MUST | Loopback, private, link-local, carrier-grade-NAT, and multicast destinations are rejected **unless** the destination is the configured endpoint (the local-model case). |
| **EG-8** | SHOULD | The set of permitted destinations is expressible as reviewable data (an allowlist), not only as code. |

**Test procedure (EG).** With a mock transport, for each adapter:

1. Issue a normal request; assert the chokepoint was entered exactly once per
   attempt and that no other network call occurred (EG-1).
2. Configure endpoint `https://api.example.test/v1`; have the mock respond `302`
   to `https://evil.example.net/v1`; assert the request is not re-issued to the
   new origin under a policy that permits endpoint-only egress (EG-2, EG-3).
3. Respond with a redirect loop; assert an error after the documented bound
   (EG-4).
4. Attempt `file:`, `ftp:`, and `data:` endpoints; assert rejection (EG-5).
5. Attempt `https://user:pass@api.example.test/v1`; assert rejection (EG-6).
6. Attempt `http://169.254.169.254/latest/meta-data` — both as configured
   endpoint and as a redirect target — and assert rejection in the redirect case
   (EG-7). Assert `http://127.0.0.1:<port>/v1` is permitted **only** when it is
   the configured endpoint.

**Pass criteria.** Every rejection is raised before any bytes are sent to the
rejected destination, and each is observable as a distinct, named error.

## 4. Credential containment (CR)

| ID | Level | Assertion |
|---|---|---|
| **CR-1** | MUST | `Authorization`, `Cookie`, and `Proxy-Authorization` are stripped when a redirect crosses to a different origin. |
| **CR-2** | MUST | Credentials never appear in audit records, logs, telemetry, error messages, or exception traces. |
| **CR-3** | MUST | The adapter persists nothing — not credentials, not request or response bodies — outside the lifetime of the request. |
| **CR-4** | SHOULD | Credentials are resolvable by indirection (environment variable or OS keychain reference), so an operator is not required to store them inline in configuration. |

**Test procedure (CR).** Configure a recognizable sentinel key. Drive a
same-origin redirect (headers retained) and a cross-origin redirect permitted by
policy (headers stripped). Then search **all** artifacts produced by the run —
audit records, stdout/stderr, thrown errors, any file the adapter wrote — for the
sentinel.

**Pass criteria.** Zero occurrences of the sentinel outside the outbound request
headers to the configured origin.

## 5. Auditability (AU)

| ID | Level | Assertion |
|---|---|---|
| **AU-1** | MUST | Every attempt emits exactly one request record, whatever the outcome (`ok` / `error` / `blocked`). |
| **AU-2** | MUST | The record identifies at minimum: provider id, model id, destination origin, outcome, duration, and status code when one exists. |
| **AU-3** | MUST | Records carry no prompt text, completion text, tool arguments, file contents, or request/response headers. |
| **AU-4** | MUST | A blocked request is recorded **before** the error is raised. |
| **AU-5** | MUST | Provider records join the same tamper-evident run log as the rest of the run — not a separate, unchained provider log. |
| **AU-6** | SHOULD | A policy denial additionally emits a violation record naming the rule that denied it. |

**Rationale for AU-4.** A denial that is not recorded is indistinguishable from
an outage after the fact — which is precisely the case a reviewer cares about.

**Test procedure (AU).** Run the EG scenarios and inspect the emitted records:
count them, check the field set, assert prompt/completion strings are absent by
substring search, and verify the chain still validates after the blocked attempt.

## 6. Policy binding (PO)

| ID | Level | Assertion |
|---|---|---|
| **PO-1** | MUST | The governing policy is consulted **per request**, not once at startup. |
| **PO-2** | MUST | Policy is re-consulted at each redirect hop. |
| **PO-3** | MUST | An absent, malformed, or unreadable policy fails closed to a documented default. It never silently degrades to unrestricted. |
| **PO-4** | MUST | No adapter option, environment variable, or configuration field widens what the governing policy allows. |
| **PO-5** | MUST | Provider identity and model identity are checked against policy allowlists before the request is issued. |
| **PO-6** | SHOULD | The policy in force is identified in the run record by a stable canonical hash. |

**Test procedure (PO).** Mutate the policy between two requests in the same run
and assert the second decision reflects the mutation (PO-1). Drive a redirect
under a policy that permits the first origin and denies the second (PO-2). Supply
a malformed policy and assert the run is more restricted, not less (PO-3).
Attempt to reach a denied model or provider via every configuration surface the
implementation exposes — CLI flag, env var, config file, profile — and assert all
are refused (PO-4, PO-5).

**Pass criteria for PO-4.** The implementation enumerates its configuration
surfaces and the test covers each. An unenumerated surface is a fail.

## 7. Behavioral contract (BE)

| ID | Level | Assertion |
|---|---|---|
| **BE-1** | MUST | Streaming yields incremental text deltas whose concatenation equals the final content. |
| **BE-2** | MUST | Tool/function calls round-trip: streamed, fragmented tool-call arguments reassemble to exactly what the non-streaming path returns for the same response. |
| **BE-3** | MUST | Transport, HTTP, and provider-level errors normalize to the runtime's error type; no provider-specific error object escapes the adapter. |
| **BE-4** | MUST | Cancellation stops the request promptly **and** still emits an audit record. |
| **BE-5** | SHOULD | Token usage is reported when the provider exposes it, and reported as *absent* — never as zero — when it does not. |
| **BE-6** | SHOULD | The adapter holds no cross-request state. |

**Rationale.** BE exists because governance controls are only trustworthy if the
adapter is otherwise boring. Silent truncation of a stream, or a tool call that
reassembles differently under streaming, produces divergence between what was
audited and what the agent acted on.

**Test procedure (BE).** Replay recorded provider responses through the mock
transport in both streaming and non-streaming modes and assert the two paths
produce equal results; split tool-call arguments across chunk boundaries mid-token
and mid-UTF-8-sequence; inject a 500, a malformed chunk, and a socket close
mid-stream; abort mid-stream and inspect the audit record.

## 8. Requirements on the suite

| ID | Level | Requirement |
|---|---|---|
| **T-1** | MUST | The suite runs fully offline against a mock transport. No test makes a real provider call. |
| **T-2** | MUST | Every MUST assertion has at least one **bypass test**: remove the control, and the test fails. |
| **T-3** | MUST | The same suite runs unmodified against every adapter (parametrized over the adapter registry). |
| **T-4** | MUST | Adding an adapter requires no new bespoke governance test — passing the suite is the gate. |
| **T-5** | SHOULD | The suite emits a report in the §10 format. |

T-2 is the load-bearing one. A suite whose tests still pass after the control is
deleted proves nothing, and this profile treats it as unimplemented.

## 9. Conformance levels

| Level | Name | Requires |
|---|---|---|
| **1** | Governed | All MUST assertions in EG, CR, AU, PO, plus T-1 – T-4. |
| **2** | Governed + Interoperable | Level 1, plus all MUST assertions in BE. |

An implementation claiming a level MUST publish a report (§10) listing every
assertion, including unmet SHOULDs. Claims are per adapter **and** per version:
"DvalinCode 0.14.0 `openaiCompatible` — PCP-1 Level 2".

**Honesty rule.** An assertion that is not implemented is reported `fail`. It is
never omitted, and never marked `not-applicable` unless the profile's own
applicability note covers the case. A partial claim that says so is worth more
than a full claim that hedges — and is far easier to verify.

## 10. Report format

`provider-conformance-report/v1` — one JSON document:

```json
{
  "schema": "provider-conformance-report/v1",
  "profile": "PCP-1",
  "profileVersion": "1.0.0-draft.1",
  "subject": { "implementation": "dvalincode", "version": "0.14.0", "adapter": "openaiCompatible" },
  "generatedAt": "2026-08-02T00:00:00.000Z",
  "levelClaimed": 2,
  "results": [
    { "id": "EG-3", "outcome": "pass", "bypassTest": true, "evidence": "tests/providers/conformance.test.ts:redirect-reauthorized" },
    { "id": "EG-8", "outcome": "fail", "note": "destination rules are code, not data" }
  ]
}
```

- `outcome` — `pass` | `fail` | `not-applicable` (with a `note` justifying it).
- `bypassTest` — whether the covering test fails when the control is removed.
  Required `true` for every MUST at the claimed level.
- `evidence` — a stable pointer (test name, file:line, or log id) a reader can
  follow.

A report is a self-assessment. It is credible in proportion to the reader's
ability to re-run it, so implementations SHOULD ship the suite alongside the
report.

## 11. Relationship to other frameworks

PCP-1 is narrow on purpose: it covers the provider boundary only, and it composes
with rather than replaces existing frameworks. For reviewers mapping it upward:
the EG and PO assertions are the technical substance behind egress-control and
access-control clauses; AU is what makes logging clauses verifiable rather than
asserted; CR covers secrets handling at this boundary. It carries no
certification, no mark, and no authority — it is a checklist with test
procedures.

## 12. Non-goals

- **Not a security certification.** Passing PCP-1 means these assertions hold. It
  says nothing about the rest of the runtime.
- **Not an adapter API.** No interface, language, or dependency is prescribed.
- **Not a policy language.** How policy is expressed and resolved is out of scope;
  only that it is consulted and cannot be widened.
- **Not a model evaluation.** Nothing here concerns model quality, cost, or
  safety behavior.
- **Not a registry.** There is no list of "certified" providers and no body that
  grants conformance.

## Appendix A — Reference implementation notes (informative)

DvalinCode's mapping, offered as one worked example rather than as part of the
profile:

| Assertion group | Where it lives |
|---|---|
| EG-1 – EG-7 | `governedProviderFetch` in [`src/providers/egress.ts`](https://github.com/arthurpanhku/dvalincode/blob/main/src/providers/egress.ts) — manual `redirect: 'manual'` loop, per-hop `checkEgress` + destination classification |
| EG-8 | `src/providers/trustedBaseUrls.ts` |
| CR-1 | header stripping on cross-origin redirect in the same loop |
| AU-1 – AU-5 | `provider_request` records appended to the run's hash chain (`src/audit/log.ts`) |
| PO-1 – PO-3 | `checkEgress(policy, isConfiguredEndpoint)` per hop; policy resolution in `src/core/policy.ts` |
| BE-1 – BE-5 | `src/providers/openaiCompatible.ts`, `src/providers/anthropic.ts` |

The executable suite tracking this profile is
[issue #118](https://github.com/arthurpanhku/dvalincode/issues/118). Where the
implementation and this profile disagree, the profile is not automatically right
— open an issue; gaps found this way are the point.

## Appendix B — Changing this profile

Assertions are added, deprecated, or clarified through issues on
[arthurpanhku/dvalincode](https://github.com/arthurpanhku/dvalincode/issues) with
the `spec` label. Rules: IDs are never reused; a new MUST is a minor version and
takes effect one minor version after publication; clarifications that do not
change what passes are patch versions. Implementations report the profile version
they tested against.
