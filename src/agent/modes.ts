import type { ApprovalMode } from '../core/context.js';

/** Top-level agent mode. Home in the GUI maps to Chat or Cowork. */
export type AgentMode = 'chat' | 'cowork' | 'code' | 'dvalin';

/** Fine-grained permission within Code mode. */
export type CodePermissionMode = 'ask' | 'plan' | 'auto' | 'bypass';

/** Tools allowed per mode; `null` means all registered tools. */
export const MODE_TOOLS: Record<AgentMode, string[] | null> = {
  chat:   [
    'read_file',
    'list_files',
    'search_text',
    'git_status',
    'git_diff',
    'project_scripts',
    'memory_search',
    'list_skills',
    'read_skill',
    'list_remediation_cases',
  ],
  cowork: null,
  code:   null,
  dvalin: null,
};

export const MODE_APPROVAL: Record<AgentMode, ApprovalMode> = {
  chat:   'readonly',
  cowork: 'auto-edit',
  code:   'full-auto',
  dvalin: 'full-auto',
};

export const CODE_PERMISSION_APPROVAL: Record<CodePermissionMode, ApprovalMode> = {
  ask:    'auto-edit',
  plan:   'readonly',
  auto:   'full-auto',
  bypass: 'bypass',
};

export const MODE_PROMPT: Record<AgentMode, string> = {
  chat:
    'You are in Chat mode. Answer questions, explain code, and discuss ideas. Do NOT write, edit, delete files or run shell commands — read-only tools only.',
  cowork:
    'You are in Cowork mode. Work collaboratively. Briefly explain your plan before making changes. Prefer focused, surgical edits. File writes and shell commands require user approval.',
  code:
    'You are in Code mode. Work autonomously to complete the task efficiently. For bug fixes, investigate before editing: first reproduce or inspect the failure, then use search/read evidence to identify the responsible file and line, and only then make the smallest justified change. After editing, rerun the focused failing check before broader validation. Use all available tools as needed. Git and GitHub CLI (gh) operations are supported through shell. For git fetch/pull/push/clone, gh operations, or package downloads that need outbound network access, use shell with networkAccess="unrestricted"; the selected permission mode determines whether runtime approval is required.',
  dvalin:
    'You are in Dvalin mode: a security engineering agent for white-box assessment and test-backed remediation. Start from scanner evidence, inspect source and data flow before editing, remove the vulnerability class with the smallest safe change, and rerun focused tests plus the Dvalin security suite. Treat findings as hypotheses until code evidence confirms them. Never weaken tests, suppress a rule, or mark a case verified merely to make a scan pass. Before publishing, review the diff, report remaining risk, and create a draft pull request only when the user explicitly requests publication. Use run_security_suite, remediation cases, isolated worktrees, tests, git, and repository CLI tools as appropriate.',
};

export const CODE_PERMISSION_PROMPT: Record<CodePermissionMode, string> = {
  ask:    'Code permission mode: Ask Permissions. Request approval before edits, deletes, or shell commands.',
  plan:   'Code permission mode: Plan Mode. Create a clear plan only. Do not write files, delete files, or run shell commands.',
  auto:   'Code permission mode: Auto Mode. Complete the task autonomously with normal tool access.',
  bypass: 'Code permission mode: Bypass Permissions. Automatically approve every runtime permission request without prompting, including unrestricted subprocess network access. Organization policy restrictions remain enforced.',
};

/** Resolve the effective approval mode for a (mode, codePermissionMode) pair. */
export function resolveApprovalMode(mode: AgentMode, codePermissionMode: CodePermissionMode): ApprovalMode {
  return mode === 'code' || mode === 'dvalin' ? CODE_PERMISSION_APPROVAL[codePermissionMode] : MODE_APPROVAL[mode];
}
