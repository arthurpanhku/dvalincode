# AI Change Impact Assessment

Use this template for high-risk AI/system changes, including changes to:

- Agent permissions, approval modes, shell/file/network tools, or policy
  enforcement.
- Prompt behavior, context selection, model/provider defaults, or provider
  request handling.
- Audit logs, report generation, data minimization, or release security.

Copy the template into the pull request description or into a dated file under
`docs/governance/assessments/` when the assessment needs to be retained as a
standalone record.

## Change Summary

- PR / issue:
- Owner:
- Date:
- Change class: A2 / A3
- Components changed:

## Intended Use

- What user workflow does this change support?
- Which modes are affected: Chat / Cowork / Code / terminal / web / server?
- Does the change alter default behavior?

## Stakeholders

- Maintainer:
- User or organization admin:
- Security reviewer:
- Affected third-party providers:

## Data and Privacy

- What user data can be read, transformed, stored, or sent to a provider?
- Are prompts, provider responses, file contents, API keys, or secrets stored?
- Does `.dvalincodeignore` or policy enforcement still apply?
- Does audit logging remain minimized?

## Autonomy and Permission Impact

- Does the change expand file write, delete, shell, network, model, or tool
  access?
- Does it change when user approval is required?
- Does it change Plan/Ask/Auto/Bypass behavior?
- What prevents prompt injection from escalating permissions?

## Model and Supplier Impact

- Are new model providers, endpoints, SDKs, or hosted services introduced?
- Are provider requests routed through the governed egress path?
- Are provider errors, rate limits, and retries safe and observable?

## Security and Supply Chain

- Are dependencies added or updated?
- Are GitHub Actions pinned to commit SHAs?
- Do CI, CodeQL, Scorecard, and release verification still run?
- Are new secrets required? If yes, where are they stored and scoped?

## Testing and Evidence

- Unit tests:
- Integration or e2e tests:
- Manual verification:
- Audit/report verification:
- Screenshots or logs:

## Residual Risk

- Remaining risks:
- Accepted exceptions:
- Owner:
- Review date:

## Decision

- [ ] Approved
- [ ] Approved with conditions
- [ ] Rejected

Reviewer:
Date:
