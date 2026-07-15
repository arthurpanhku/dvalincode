# Skills

DvalinCode skills are local instruction bundles stored under
`~/.dvalincode/skills`. They make repeatable agent workflows portable across
machines and teams.

## Bundle Format

Skills are uploaded and downloaded as JSON:

```json
{
  "app": "dvalincode-skill",
  "version": 1,
  "manifest": {
    "name": "secure-code-scan",
    "title": "Secure Code Scan",
    "description": "Scan the current workspace for high-signal security risks.",
    "version": "1.0.0",
    "tools": ["run_security_scan"]
  },
  "files": {
    "SKILL.md": "# Secure Code Scan\n\nUse this skill when..."
  }
}
```

`SKILL.md` is required. Additional reference files may be included under
subdirectories such as `references/`.

## Built-In Skills

DvalinCode installs three built-in security skills automatically:

- `secure-code-scan` — guides local security scanning and remediation case
  creation.
- `secure-code-remediation` — guides isolated worktree preparation, minimal
  fixes, verification, and PR-ready reporting.
- `dvalin-security-engineer` — orchestrates the full multi-scanner Dvalin
  workflow from white-box triage through tested remediation and draft-PR prep.

## Agent Tools

The agent can use these skill and remediation tools:

- `list_skills`
- `read_skill`
- `run_security_scan`
- `run_security_suite`
- `list_remediation_cases`
- `prepare_remediation_worktree`

The scan tools write local remediation cases, so they are treated as
write/execute tools and are not available in read-only Chat mode.
