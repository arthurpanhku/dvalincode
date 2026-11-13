import { z } from 'zod';
import { assertRevision, gitRead, workspaceGitPath } from '../core/gitRead.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    filePath: z.string().min(1).optional().describe('Only commits that changed this file or directory (it may since have been deleted).'),
    ref: z.string().min(1).max(200).optional().describe('Where to start: a branch, tag, commit, or range such as main..HEAD (default: HEAD).'),
    grep: z.string().min(1).max(200).optional().describe('Only commits whose message contains this text (case-insensitive).'),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const gitLogTool: Tool<Input> = {
  name: 'git_log',
  description:
    'List commits (hash, date, author, subject), optionally only those that changed a path or whose message matches text. Use it to find when and why code changed; read a commit with git_show.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,
  policyTargets: input => (input.filePath ? [{ kind: 'path', value: input.filePath }] : []),

  async run(input, context) {
    const args = ['log', '--no-color', '--no-show-signature', `-n${input.limit}`, '--date=short', '--format=%h  %ad  %an  %s'];
    if (input.grep) args.push('--fixed-strings', '--regexp-ignore-case', `--grep=${input.grep}`);
    args.push('--end-of-options', input.ref ? assertRevision(input.ref) : 'HEAD', '--');
    if (input.filePath) {
      const patterns = await loadIgnorePatterns(context.cwd);
      args.push(`:(literal)${await workspaceGitPath(context.cwd, input.filePath, patterns)}`);
    }

    const { stdout } = await gitRead(args, context.cwd, 64_000);
    const commits = stdout.trimEnd();
    const count = commits ? commits.split('\n').length : 0;
    return {
      title: `git log${input.filePath ? ` ${input.filePath}` : ''}`,
      output: commits || 'No commits found.',
      metadata: { commits: count, ref: input.ref ?? 'HEAD', filePath: input.filePath },
    };
  },
};
