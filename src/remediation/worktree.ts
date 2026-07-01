import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertInsidePath, resolveWorkspaceRoot } from '../core/workspace.js';
import type { RemediationFinding } from './sarif.js';

// These are local, fixed-argv git calls (no shell, no fetch) and are a documented
// exemption from the network sandbox — see docs/EGRESS-THREAT-MODEL.md →
// "Remediation subprocesses". Governance guardrail: do NOT add a step here that
// applies a fix or runs a command on the user's behalf via this direct execFile.
// Any such subprocess must go through `runGovernedProcess` (sandbox + checkEgress)
// and be audited, exactly like the `shell` tool.
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
  let out = '';
  let previousDash = true;
  for (const char of value.toLowerCase()) {
    const allowed = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '_';
    if (allowed) {
      out += char;
      previousDash = false;
    } else if (!previousDash) {
      out += '-';
      previousDash = true;
    }
    if (out.length >= 56) break;
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out || 'security-finding';
}

function shortId(value: string): string {
  let out = '';
  for (const char of value) {
    const alpha = (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');
    const digit = char >= '0' && char <= '9';
    if (alpha || digit) out += char;
    if (out.length >= 8) break;
  }
  return out || Date.now().toString(36);
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
  const resolvedBase = await resolveWorkspaceRoot(baseCwd);
  const { stdout: repoRootRaw } = await execAsync('git', ['rev-parse', '--show-toplevel'], { cwd: resolvedBase });
  const repoRoot = await realpath(repoRootRaw.trim());
  const repoName = path.basename(repoRoot);
  const branch = remediationBranchName(finding);
  const remediationRoot = path.resolve(dvalinHome(), 'projects', 'remediations');
  const targetName = slug(`${repoName}-${branch}`);
  const target = assertInsidePath(remediationRoot, path.resolve(remediationRoot, targetName), targetName);

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
