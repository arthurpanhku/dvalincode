# Release Evidence Pack

## Why

[`docs/EVIDENCE-PACK.md`](EVIDENCE-PACK.md) makes a *running install* provable:
its policy, its posture, its audit chains. But a reviewer meets the project
before they install anything — at the release page — and there the only thing on
offer is prose. "Tamper-evident audit trail" is a claim like any other until
someone runs the binary.

Every release therefore ships **`dvalincode-v<version>-evidence.json`**: an
Evidence Pack produced *by the shipped binary*, from real governed runs on the
build machine, downloadable and re-verifiable offline before a single line of
DvalinCode is installed.

This is the project's habit stated as an artifact: **claims ship with the
evidence that backs them.** Ordinary release notes say what changed; this says
what the build actually did, in a form the reader can re-derive.

## What is in it

The format is unchanged — Evidence Pack v1, verified by the same
`dvalincode evidence verify`. What the release adds is *which runs are inside*.
Two, on purpose:

| Run | Setup | Proves |
|---|---|---|
| **allowed** | Plan mode (read-only) over the release tree | the normal path is fully audited — including a `file_read` record whose `sha256` is the released `README.md` itself |
| **denied** | Auto mode in a fixture workspace whose `dvalin.policy.json` sets `commands.defaultDeny` | enforcement is real: the agent asks for a shell command, the policy blocks it, and `policy_violation` — naming the rule — lands in the chain |

A pack with only the happy path shows a tool that logs. A pack containing a
recorded denial shows a tool that *stops*, and lets the reader check the stop is
in the same hash chain as everything else.

## The model is a deterministic local stub

The runs are driven by a small OpenAI-compatible endpoint on `127.0.0.1` that
replays a fixed script (`scripts/release-evidence.mjs`). No API key, no egress,
no model vendor in the release path — a release build must be reproducible and
offline.

This is recorded, not hidden: the audit records carry
`provider: evidence-stub`, `model: deterministic-stub-v1`, and a
`provider_request` to a loopback origin. The pack never implies a real model
ran. It is evidence about **governance** — policy resolution, egress
chokepoint, audit integrity, enforcement — which is exactly the part that must
behave identically whichever model a user later brings.

## How it is produced

```sh
npm run evidence:release            # uses the built binary for this host
node scripts/release-evidence.mjs --bin <path-to-binary> --out <file>
```

In CI (`.github/workflows/release.yml`, after checksum verification):

1. The **shipped** macOS archive is extracted and its binary is used — the
   evidence comes from the artifact users download, not from a source checkout.
2. Both runs execute under a throwaway `HOME`, so the pack contains those runs
   and nothing else from the build machine.
3. `evidence export` → `evidence verify` → structural assertions (below).
4. The pack's SHA-256 is appended to `SHA256SUMS.txt`, which is then re-verified
   and is the subject of the existing build-provenance attestation — so the pack
   inherits the release's supply-chain signature without a new trust surface.
5. The pack is attached to the GitHub Release next to the archives.

## Acceptance matrix

The script fails the release build — it does not warn — when any of these fail:

| Case | Expected |
|---|---|
| Either run fails to record a run id | build fails; no pack is published |
| Fewer than 2 runs in the pack | build fails |
| Any embedded chain fails `verifyRecords` | build fails |
| No `policy_violation` record present | build fails — the denial run did not prove enforcement |
| `pack.tool.version` ≠ `package.json` version | build fails |
| `evidence verify` on the written file | exits 0, all section hashes match |
| Credential-shaped key with a value anywhere in the pack | `verify` reports a minimization issue → build fails |
| Appended checksum line | `shasum -c SHA256SUMS.txt` passes with the pack included |

## What a reviewer can do with it

Download the pack from the release page, then, with no DvalinCode installed and
no network:

```sh
dvalincode evidence verify dvalincode-v0.14.0-evidence.json
```

(or re-derive the hashes with any SHA-256 implementation — the format is
documented in [EVIDENCE-PACK.md](EVIDENCE-PACK.md) and the canonicalization rule
is plain sorted-key JSON). They can read the resolved policy, see the enforcement
posture the build self-reports, and follow both runs record by record.

## Non-goals

- **Not a security certification.** The pack proves what these two runs did and
  that the records are intact. It does not prove the absence of vulnerabilities,
  and nothing in it should be read as a pass mark.
- **Not a substitute for the per-install pack.** A company's approval evidence
  is the pack from *their* machine under *their* policy. The release pack shows
  the shipped binary behaves as documented; it says nothing about anyone's
  deployment.
- **Not model evidence.** The stub says nothing about model quality, cost, or
  behavior.
- **No new pack schema.** The release pack is Evidence Pack v1, byte-for-byte
  the same format a user exports locally; only the provenance of the runs
  differs.
