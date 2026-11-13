# Roadmap tool changes

Every model-facing operation uses the registry for permissions, policy and audit. Provider history receives redacted tool text, while undo retains local originals. Concurrent reads use the same context and complete before the next mutation.

| Issue | Acceptance |
|---|---|
| [#298](https://github.com/arthurpanhku/dvalincode/issues/298) | Tool success and error text is filtered before history and truncation. Audit records counts only. |
| [#301](https://github.com/arthurpanhku/dvalincode/issues/301) | After edits, project diagnostics use an explicitly configured, governed check. Output identifies the edited file and distinguishes unavailable diagnostics from a clean check. |
| [#302](https://github.com/arthurpanhku/dvalincode/issues/302) | Contiguous opted-in local reads overlap with a bounded width. Writes, execution, and interactive calls form barriers. Results follow request order. |
| [#303](https://github.com/arthurpanhku/dvalincode/issues/303) | Policy ceilings narrow across sources. Requests reserve capacity before sending. Adapters without trustworthy accounting fail closed under a budget. |
| [#305](https://github.com/arthurpanhku/dvalincode/issues/305) | An explicit answer is required, and an unattended surface returns an actionable result immediately. Answer content stays out of audit. |
| [#308](https://github.com/arthurpanhku/dvalincode/issues/308) | Recognized diagnostic lines produce bounded file, line and message fields. Raw output and observed exit status remain available. |
| [#309](https://github.com/arthurpanhku/dvalincode/issues/309) | Every target passes policy before mutation. All patches preflight, results carry per-file hashes, and undo checks post-edit hashes before restoring. |
| [#310](https://github.com/arthurpanhku/dvalincode/issues/310) | An operator can select a configured SearXNG endpoint. Requests use the public web boundary and audit origin only. |

## Run-scoped dev server (#299)

A local dev server needs two separate capabilities, process supervision and loopback HTTP. The design is opt-in, and each new capability requires its own policy and audit checks.

- A dedicated start tool uses the same command gate as shell. It accepts a requested HTTP port and an executable with arguments. It must launch with workspace write scope, an isolated network namespace or equivalent isolation, and a scrubbed environment. A platform that cannot enforce the required profile reports unavailable.
- A per-turn supervisor owns the process tree. It registers a port only after an isolated readiness probe, verifies that the listener belongs to the supervised service, and tears down and reaps descendants on completion, interruption, timeout or startup failure.
- A separate loopback HTTP path accepts only the supervisor's run-local service handle. It uses a literal address, disables proxies, forbids redirects, and bounds time and response bytes. The public web path retains its public-address checks.
- Audit records record the start decision, executable fingerprint, port, readiness, bounded HTTP outcome, and final cleanup. Output, paths, query text, and credentials are excluded from those records.

| Scenario | Expected result |
|---|---|
| Outbound or LAN traffic from the child | Blocked by the enforced network profile |
| Another process pre-binds the port | Start fails and creates no usable handle |
| Handle used from a different turn | Rejected before any connection |
| Redirect, oversized response, or cancelled turn | No redirect followed, bounded result, and process tree reaped at turn end |
| Enforcement unavailable | Start rejected with an explicit unavailable result |

## CLI and Web release supply chain (#304)

Generate separate CycloneDX inventories from the backend and frontend runtime lockfile graphs. The release checksum list and build provenance cover both. These describe npm dependencies from the lockfiles. The compiled Bun runtime and platform binaries have their own artifact checksums.

The existing cross-build can sign the Windows PE before packaging with osslsigncode. Configure a PKCS#12 code-signing credential and RFC 3161 timestamp URL in CI. A configured signer must succeed before archives and checksums are published. A build without a certificate reports the unsigned Windows artifact in its workflow log.

| Scenario | Expected result |
|---|---|
| Missing or invalid lockfile | SBOM generation fails |
| Credential configured and signing fails | Build fails before packaging Windows |
| Credential absent | Workflow records unsigned status |
| Bundle, SBOM, or evidence changed | Release checksum verification fails |

## Image attachments (#306)

The Web/Desktop composer accepts up to four JPEG, PNG, GIF or WebP attachments, with a 2 MiB limit per image. Server validation checks canonical base64 and file signatures. The current adapter must opt in for the specific model. Images are included in provider requests as native blocks and kept for the active turn. The durable text transcript records attachment counts and does not store image bytes. Images require a separate budget accounting implementation when model budgets are active.

| Scenario | Expected result |
|---|---|
| Unsupported media, oversized payload, or unsupported model | Explicit validation error before egress |
| OpenAI or Anthropic supported model | Text and image blocks travel in the same governed request |
| Session save, audit export, or compaction | No raw attachment bytes in persisted text or audit |

## Run-level rollback (#300)

With operator opt-in, snapshot regular tracked and non-ignored untracked workspace files before and after an interactive acting turn. Preserve content and modes, limit snapshot size, and refuse rollback when any changed file has diverged from the after snapshot. Store snapshots outside the repository in the local profile with restricted permissions. Git metadata, the index, ignored output, and paths outside the workspace are beyond this snapshot's coverage. If capture fails, the run report gives the reason and no rollback action is offered.

| Scenario | Expected result |
|---|---|
| Shell changes, creates or deletes a covered file | Before and after snapshots identify the affected paths |
| User changes a covered path after the run | Entire rollback stops before restoring any path |
| Policy denies a path or a path becomes a symlink | Entire rollback stops during preflight |
| Non-Git workspace or unsupported snapshot | Run continues with an explicit unavailable reason |

## Operator settings

- Set `DVALINCODE_EDIT_DIAGNOSTICS=typecheck,lint` to run the corresponding project checks after edits. Commands require the turn's execution permission and consume tool-call budget.
- Set `DVALINCODE_PRE_TOOL_COMMAND` or `DVALINCODE_POST_TOOL_COMMAND` in the operator environment to run a command around a tool call. The pre-tool command runs after approval and blocks the tool on failure. The post-tool command runs after a successful tool result. Both use the command policy and governed subprocess path.
- Set `DVALINCODE_RUN_CHECKPOINTS=1` for interactive snapshots. Use the run report or `dvalincode checkpoint list` and `dvalincode rollback <run-id>` from the captured workspace. Snapshots contain original file bytes and are stored under the local profile.
- Set `DVALINCODE_SEARXNG_URL` or use Settings to select an instance's full search endpoint. Enable JSON in the instance's search formats. [SearXNG search API](https://docs.searxng.org/dev/search_api.html)
- Set `WINDOWS_SIGNING_P12`, `WINDOWS_SIGNING_PASSWORD`, and `WINDOWS_SIGNING_TIMESTAMP_URL` in the release repository to enable Authenticode. [osslsigncode documentation](https://github.com/mtrojnar/osslsigncode/blob/master/osslsigncode.md)
