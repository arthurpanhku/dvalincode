import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemediationFinding } from './sarif.js';

const execAsync = promisify(execFile);

export type RemediationWorktreeResult = {
  cwd: string;
  branch: string;
  baseCwd: string;
  prompt: string;
};

type WorktreeFinding = Pick<RemediationFinding, 'id' | 'ruleId' | 'path' | 'startLine' | 'message' | 'prompt'>;

function dvalinHome(): string {
  return process.env.DVALINCODE_HOME ?? path.join(homedir(), '.dvalincode');
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[./]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'security-finding';
}

function shortId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 8) || Date.now().toString(36);
}

export function remediationBranchName(finding: WorktreeFinding, now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `dvalin/remediate/${date}-${slug(`${finding.ruleId}-${finding.path}`)}-${shortId(finding.id)}`;
}

function worktreePrompt(finding: WorktreeFinding, result: Omit<RemediationWorktreeResult, 'prompt'>): string {
  return [
    'Secure remediation task in isolated worktree:',
    '',
    `Worktree: ${result.cwd}`,
    `Branch: ${result.branch}`,
    `Original workspace: ${result.baseCwd}`,
    '',
    'Before editing:',
    '1. Confirm commands run in the worktree path above.',
    '2. Keep the fix scoped to this finding unless directly related changes are necessary.',
    '',
    finding.prompt,
  ].join('\n');
}

export async function createRemediationWorktree(baseCwd: string, finding: WorktreeFinding): Promise<RemediationWorktreeResult> {
  const resolvedBase = await realpath(baseCwd);
  const { stdout: repoRootRaw } = await execAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedBase });
  const repoRoot = await realpath(repoRootRaw.trim());
  const repoName = path.basename(repoRoot);
  const branch = remediationBranchName(finding);
  const target = path.join(dvalinHome(), 'projects', 'remediations', repoName, branch.replace(/[\\/]/g, '-'));

  await mkdir(path.dirname(target), { recursive: true });
  await execAsync('git', ['worktree', 'add', '-b', branch, target, 'HEAD'], { cwd: repoRoot });

  const cwd = await realpath(target);
  const result = {
    cwd,
    branch,
    baseCwd: repoRoot,
  };
  return {
    ...result,
    prompt: worktreePrompt(finding, result),
  };
}
