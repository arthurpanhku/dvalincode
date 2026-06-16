import type { ApprovalMode } from '../core/context.js';

/** Top-level agent mode (mirrors the GUI's Chat / Cowork / Code switch). */
export type AgentMode = 'chat' | 'cowork' | 'code';

/** Fine-grained permission within Code mode. */
export type CodePermissionMode = 'ask' | 'plan' | 'auto' | 'bypass';

/** Tools allowed per mode; `null` means all registered tools. */
export const MODE_TOOLS: Record<AgentMode, string[] | null> = {
  chat:   ['read_file', 'list_files', 'search_text', 'git_status', 'git_diff', 'project_scripts', 'memory_search'],
  cowork: null,
  code:   null,
};

export const MODE_APPROVAL: Record<AgentMode, ApprovalMode> = {
  chat:   'readonly',
  cowork: 'auto-edit',
  code:   'full-auto',
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
    'You are in Code mode. Work autonomously to complete the task efficiently. Use all available tools as needed.',
};

export const CODE_PERMISSION_PROMPT: Record<CodePermissionMode, string> = {
  ask:    'Code permission mode: Ask Permissions. Request approval before edits, deletes, or shell commands.',
  plan:   'Code permission mode: Plan Mode. Create a clear plan only. Do not write files, delete files, or run shell commands.',
  auto:   'Code permission mode: Auto Mode. Complete the task autonomously with normal tool access.',
  bypass: 'Code permission mode: Bypass Permissions. Complete the task without approval prompts.',
};

/** Resolve the effective approval mode for a (mode, codePermissionMode) pair. */
export function resolveApprovalMode(mode: AgentMode, codePermissionMode: CodePermissionMode): ApprovalMode {
  return mode === 'code' ? CODE_PERMISSION_APPROVAL[codePermissionMode] : MODE_APPROVAL[mode];
}
