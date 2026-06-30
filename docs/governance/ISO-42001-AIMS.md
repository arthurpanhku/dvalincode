# ISO/IEC 42001 AIMS Alignment

This document describes how DvalinCode aligns its project governance with
ISO/IEC 42001, the AI management system standard. It is an internal control map
and evidence plan, not a claim of ISO certification.

## References

- ISO/IEC 42001 standard page: https://www.iso.org/standard/81230.html
- ISO AI management systems overview: https://www.iso.org/artificial-intelligence/ai-management-systems

## Scope

The AI management system scope covers:

- DvalinCode source code, build workflows, release artifacts, and security docs.
- Agent behavior exposed through Chat, Cowork, Code, terminal, web, and server
  interfaces.
- Model/provider integrations, prompts, tool execution, audit logs, local data,
  and policy enforcement.
- Governance evidence for maintainers and users evaluating enterprise adoption.

Out of scope:

- The internal controls of third-party model providers.
- A user's private prompts, repositories, API keys, and local runtime
  configuration after installation.
- Formal ISO certification activities performed by an accredited certification
  body.

## AI Policy

DvalinCode's AI policy is:

1. Keep the user or organization in control of model, tool, file, shell, and
   network permissions.
2. Treat model output as untrusted input.
3. Minimize data captured in audit records and never store prompt bodies,
   provider bodies, API keys, or file contents in audit logs.
4. Make AI behavior reviewable through open source code, tests, policy files,
   and tamper-evident run logs.
5. Preserve local-first operation and avoid hidden vendor lock-in.
6. Record material AI behavior changes through a pull request checklist and, for
   higher-risk changes, an AI change impact assessment.

## Roles

| Role | Responsibility | Evidence |
|---|---|---|
| AIMS owner | Maintains this control map and review cadence | This document |
| Security owner | Maintains Scorecard, CodeQL, security policy, and release checks | `SECURITY.md`, `.github/workflows/` |
| Release owner | Verifies build outputs, checksums, and release notes | `release.yml`, `scripts/build-release.sh` |
| AI behavior owner | Reviews prompts, tools, policy enforcement, provider changes, and mode behavior | PR checklist, tests |
| Incident owner | Coordinates security or AI behavior incidents | `SECURITY.md`, issue template |

For this public repository, these roles may be held by the same maintainer. For
enterprise forks, assign named people or teams.

## Control Map

| Management-system need | DvalinCode implementation | Evidence |
|---|---|---|
| Context and interested parties | Enterprise approval goal and threat models are documented | `docs/APPROVABILITY-PLAN.md`, `docs/EGRESS-THREAT-MODEL.md` |
| Leadership and policy | AI policy and security expectations are documented | This document, `SECURITY.md` |
| Risk planning | AI risks are tracked with controls and review triggers | Risk register below, impact assessment template |
| Support and competence | Contributor expectations and PR checklist guide maintainers | `CONTRIBUTING.md`, PR template |
| Operation | Tool permissions, policies, audit logs, and release workflows govern behavior | `src/core/`, `src/audit/`, `.github/workflows/` |
| Data governance | Audit data minimization and local-first storage are documented | `docs/AUDIT-TRAIL.md`, `docs/EGRESS-THREAT-MODEL.md` |
| Supplier and model governance | Provider changes require impact review | PR template, impact assessment template |
| Performance evaluation | CI, tests, Scorecard, CodeQL, and release verification provide recurring checks | `.github/workflows/` |
| Improvement | Issues, incidents, and Scorecard findings feed back into docs, tests, and policy | Issue template, Scorecard doc |

## Risk Register

| Risk | Impact | Baseline control | Review trigger |
|---|---|---|---|
| Prompt injection causes unauthorized write or command | User code or data may be changed unexpectedly | Approval modes, diff preview, policy engine, audit trail | Any tool permission or mode change |
| Sensitive data reaches a model provider | Confidential data may leave the workspace or machine | Local-first design, `.dvalincodeignore`, audit minimization, egress policy | New provider, file selection, or context ingestion change |
| Provider or model behavior changes unexpectedly | Agent quality, privacy, or safety posture may change | Provider profiles, local model support, impact assessment | New provider, default model, endpoint, or prompt policy |
| Supply-chain compromise in build or CI | Release artifacts may be untrusted | Pinned Actions, CodeQL, Dependabot, release checksums | Workflow, dependency, or release script change |
| Audit evidence is incomplete or misleading | Users cannot reconstruct agent behavior | Hash-chained logs and report verification | Audit schema, minimization, or report change |
| Users overestimate ISO/Scorecard meaning | Misplaced trust or compliance claims | Clear non-certification language | README, release, or marketing claim change |

## AI Change Classification

Use this lightweight classification in pull requests:

| Class | Examples | Required evidence |
|---|---|---|
| A0 documentation-only | README typo, screenshots | Normal review |
| A1 low-risk implementation | UI styling, test-only changes | Tests or rationale |
| A2 behavior-affecting AI change | Prompt, mode behavior, provider config, context selection | Tests plus PR governance checklist |
| A3 high-risk AI/system change | Permission model, shell/file/network tools, audit, release, default provider | AI impact assessment plus maintainer review |

Use `docs/governance/AI-CHANGE-IMPACT-ASSESSMENT.md` for A3 changes and for any
A2 change where data exposure, autonomy, or user approval behavior is uncertain.

## Required Records

Keep these records in git or GitHub:

- Pull requests and reviews for security or AI behavior changes.
- Completed AI impact assessments for A3 changes.
- Scorecard and CodeQL run history.
- Release notes, checksums, and build logs.
- Security incidents and corrective actions.
- Exceptions where a control is knowingly deferred, including owner and review
  date.

## Review Cadence

- Review this AIMS document every quarter or after any A3 change.
- Review Scorecard and CodeQL findings weekly via scheduled workflows.
- Review the risk register before each major release.
- Review incidents within seven days of closure and capture corrective actions.

## Certification Note

ISO/IEC 42001 certification requires a formal audit against the full standard
and organizational evidence beyond this repository. This repository provides
implementation evidence and operating procedures that can support such an audit,
but it does not by itself establish certification.
