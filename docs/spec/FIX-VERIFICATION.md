# Fix Verification Profile v1 (FVP-1)

**Status:** draft · **Version:** 1.0.0-draft.1 ·
**License:** MIT, same as the project — copy it, fork it, implement it, no permission needed.

## 0. What a fix record claims, and what it does not

Read this section before any other. Everything below exists to keep this
boundary intact.

A Verified Fix Record asserts exactly this:

> **These named findings were present in a scan of this code. After a change,
> a re-scan by the verifier no longer reported them, and these named commands
> were executed by the verifier, which observed these exit codes.**

It does **not** assert, and MUST NOT be presented as asserting:

- that the code is free of vulnerabilities;
- that the change is correct, or that it preserves behavior;
- that the scanners were capable of finding the class of defect in question;
- that anything outside the recorded coverage was examined at all.

A record is evidence about a *procedure that was carried out*. It is not a
safety certificate, and an implementation that markets it as one is not
conformant with this profile regardless of how many assertions below it passes.

## Scope

When an agent writes a repair for a security finding, someone has to decide
whether the repair worked. In most tools that decision is made by asking the
model that produced the repair — directly, or by parsing its own summary of what
it did. That is the one question a model is structurally least able to answer
against its own interest, and no amount of prompt wording changes it.

FVP-1 specifies an arrangement where the decision does not depend on the
repairer at all, and where the resulting record can be re-derived by a third
party who trusts neither the repairer nor the verifier's own report of itself.

This document specifies:

- the roles and the separation between them (§1–§2);
- what a conformant verifier MUST do before issuing a record (§3);
- the record format and its integrity properties (§4);
- how a record is re-derived offline (§5);
- coverage and the honesty rules that bound a claim (§6);
- what may be claimed at each conformance level (§7).

It does **not** specify a scanner, a rule format, a policy language, an audit
format, or a programming interface. It constrains observable behavior only. An
implementation with a completely different architecture can be conformant.

### Audience

Authors of security-scanning and auto-remediation tools; agent runtime authors;
security reviewers deciding how much weight to put on an automated fix; anyone
building a release gate that agent-written code has to pass.

### Conventions

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted
as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119). Assertion
IDs are stable across patch and minor versions of this profile; an assertion is
never renumbered, only deprecated.

## 1. Terms

| Term | Meaning |
|---|---|
| **Executor** | Whoever or whatever edited the code: an agent, a person, another tool. |
| **Verifier** | The component that issues the record. It re-scans, runs the checks, and decides the verdict. |
| **Target** | A finding the repair is meant to eliminate, identified by a fingerprint stable under small edits. |
| **Check** | A command belonging to the project — its tests, type checker, build — executed by the verifier. |
| **Observed exit code** | An exit code the verifier read from a process it started itself. |
| **Coverage** | What the scan actually examined, and what it did not. |
| **Record** | The issued artifact described in §4. |

## 2. Separation of executor and verifier

**FV-1.** The verifier MUST determine the verdict without consulting the
executor. Specifically, the executor's natural-language output, self-report,
summary, or any structured claim it emits MUST NOT be an input to the verdict.

**FV-2.** The executor's identity MUST be recorded and MUST NOT affect the
verdict. A record produced for a repair written by a person and one written by
an agent are evaluated identically.

> *Rationale.* If the identity of the repairer changed the standard of proof,
> the record would be measuring reputation rather than the repair. Recording the
> executor is still useful — a reviewer may want to know — so the requirement is
> that it be present and inert, not that it be absent.

**FV-3.** The verifier MUST start every check process itself and read the exit
code from that process. Accepting an exit code, test result, or pass/fail
verdict reported by another party does not satisfy this profile.

**FV-4.** Where the verifier and the executor are parts of one product, the
implementation MUST document the boundary between them and MUST NOT allow the
executor to configure, select, or suppress the checks the verifier runs.

## 3. What a verifier MUST do before issuing a record

**FV-5.** The verifier MUST re-scan the code after the change, using at least
the engines that produced the targets.

**FV-6.** The verifier MUST determine, per target, whether it is still present,
using a fingerprint that is not defeated by the finding moving within a file or
by its message being reworded.

**FV-7.** The verifier MUST attempt the project's own checks and MUST record
each one it ran with the command and the observed exit code.

**FV-8.** A project for which the verifier could execute **no** check MUST NOT
receive a verified record. An unverifiable repair is not a verified one, and
"there was nothing to run" is not a pass.

**FV-9.** Every check command MUST pass whatever authorization the implementation
applies to other command execution. A verifier MUST NOT hold a privileged path
that ordinary tool execution does not. A denied command MUST be recorded as a
check that did not pass, never silently omitted.

**FV-10.** The verdict MUST be `verified: false` if any of the following hold:
any target is still present; any executed check did not pass; no check was
executed.

## 4. Record format and integrity

**FV-11.** A record MUST carry, at minimum:

| Field | Meaning |
|---|---|
| `schema` | Identifies the format and version. |
| `generatedAt` | When the record was issued. |
| `tool` | The verifier's name and version. |
| `executor` | Who edited the code (§FV-2). |
| `before` | The originating scan: identifier, completion time, coverage, and the targets. |
| `after` | The verifying scan: identifier, completion time, coverage, and the targets still present. |
| `checks` | Each executed check: what was run, the observed exit code, whether it passed. |
| `assurance` | Whether checks were executed at all. |
| `verdict` | The boolean plus the reasons and caveats behind it. |
| `recordHash` | Integrity over everything above. |

A record MAY additionally carry the changed files and a hash over them, an
anchor into a tamper-evident log, and the hash of the governing policy.

**FV-12.** `recordHash` MUST be computed over a canonical serialization of the
record with `recordHash` itself excluded, such that two implementations
serializing the same record in a different key order compute the same hash.

**FV-13.** The verdict MUST be **derivable** from the rest of the record by the
rules in §FV-10. It is stored for convenience, not as an independent input.

> *Rationale.* Storing a verdict that cannot be recomputed would make the record
> only as trustworthy as its issuer's honesty at the moment of issue. Because it
> is derived, a record whose verdict was edited and whose hash was then
> recomputed to match still fails re-derivation. Both defenses are required;
> neither is sufficient alone.

**FV-14.** A verifier MUST issue a record whether the verdict is positive or
negative. Issuing records only on success turns the artifact into an award and
makes its absence unreadable.

**FV-15.** A record MUST NOT contain credentials, tokens, or the contents of
scanned files. It names locations and rules; it is not a copy of the code.

## 5. Offline re-derivation

**FV-16.** An implementation MUST provide a way to re-derive a record that
requires no access to the workspace, no network, and no state held by the
verifier.

**FV-17.** Re-derivation MUST recompute `recordHash` and MUST re-derive the
verdict per §FV-13, and MUST fail if either disagrees with the record.

**FV-18.** Re-derivation answers whether the record is sound and unmodified. It
does **not** answer whether the repair is still good; an implementation MUST NOT
present a successful re-derivation as a current statement about the code.

**FV-19.** A re-derivation failure MUST be distinguishable, by exit status or
equivalent, from a malformed input and from an internal error. A pipeline has to
tell "this record does not hold up" from "you pointed me at the wrong file".

## 6. Coverage and honesty rules

**FV-20.** Both scans in a record MUST carry a coverage status of `complete`,
`partial`, or `unknown`.

**FV-21.** Coverage MUST be `partial` when any selected engine did not complete,
when results were discarded, or when the scan was narrowed to a subset of the
code. It MUST be `unknown` when the implementation cannot establish what was
examined — including for records written before it tracked coverage.

**FV-22.** A finding absent from a scan whose producing engine did not complete
MUST NOT be reported as resolved. It MUST be reported as unknown.

> *Rationale.* This is the most commonly violated rule in existing tools, and
> the most damaging, because it silently converts "we did not look" into "it is
> fixed" — in the direction that makes the tool look effective.

**FV-23.** Coverage below `complete` MUST be surfaced in the record's reasons.
It does not by itself invalidate a passing verdict — a check that passed did
pass — but a record MUST NOT be presented without it.

**FV-24.** An implementation MUST NOT present a fix record as a statement that
the code is free of vulnerabilities (§0).

## 7. Conformance levels

**Level 1 — Independent verification.** FV-1 through FV-15 and FV-20 through
FV-24. Permits: *"repairs are verified independently of whoever wrote them."*

**Level 2 — Re-derivable evidence.** Level 1 plus FV-16 through FV-19. Permits:
*"the verification can be re-derived by a third party offline."*

An implementation claiming a level MUST publish which assertions it satisfies
and MUST NOT claim a level on the strength of a subset.

## 8. Reference implementation

DvalinCode implements this profile. The verifier is
[`src/remediation/verify.ts`](https://github.com/arthurpanhku/dvalincode/blob/main/src/remediation/verify.ts)
(observed exit codes, policy-gated commands) driven through
[`src/security/verifyRun.ts`](https://github.com/arthurpanhku/dvalincode/blob/main/src/security/verifyRun.ts);
the record format and its derivation rules are in
[`src/security/fixRecord.ts`](https://github.com/arthurpanhku/dvalincode/blob/main/src/security/fixRecord.ts);
coverage and the resolved/unknown distinction are in
[`src/security/contracts.ts`](https://github.com/arthurpanhku/dvalincode/blob/main/src/security/contracts.ts).

Offline re-derivation is `dvalin verify-fix <record.json>`, and the same check is
exposed to other agents as the `dvalin_verify_fix` MCP tool. This is published
as a profile rather than as a feature so that it can be held against DvalinCode
too: an assertion this implementation fails is a bug in this implementation, not
an amendment to the profile.
