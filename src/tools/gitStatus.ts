import { z } from 'zod';
import { gitRead } from '../core/gitRead.js';
import type { Tool } from './types.js';

const inputSchema = z.object({}).strict();

async function git(args: string[], cwd: string): Promise<string> {
  return (await gitRead(args, cwd, 256_000)).stdout.trim();
}

export const gitStatusTool: Tool<z.infer<typeof inputSchema>> = {
  name: 'git_status',
  description:
    'Show the current git branch, last 5 commits, and changed files. Use this to understand the git state before making changes.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,

  async run(_input, context) {
    const cwd = context.cwd;
    const parts: string[] = [];

    try {
      const branch = await git(['branch', '--show-current'], cwd);
      parts.push(`Branch: ${branch || '(detached HEAD)'}`);

      const log = await git(['log', '--oneline', '-5'], cwd);
      if (log) {
        parts.push('', 'Recent commits:');
        for (const line of log.split('\n')) parts.push(`  ${line}`);
      }

      const status = await git(['status', '--porcelain'], cwd);
      if (status) {
        parts.push('', 'Changed files:');
        for (const line of status.split('\n')) parts.push(`  ${line}`);
      } else {
        parts.push('', 'Working tree clean.');
      }
    } catch {
      return { title: 'git_status', output: 'Not a git repository or git is not installed.' };
    }

    return { title: 'git status', output: parts.join('\n') };
  },
};
