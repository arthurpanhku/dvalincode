import { z } from 'zod';
import { assertRevision, excludePathspecs, gitRead, workspaceGitPath } from '../core/gitRead.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    ref: z.string().min(1).max(200).default('HEAD').describe('Commit, tag, or branch to show (default: HEAD).'),
    filePath: z.string().min(1).optional().describe('Only show changes to this file or directory.'),
    statOnly: z.boolean().default(false).describe('List the changed files with line counts instead of the full diff.'),
    maxBytes: z.number().int().positive().max(128_000).default(64_000),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const gitShowTool: Tool<Input> = {
  name: 'git_show',
  description:
    'Show one commit: its author, date, full message, and diff (or only the changed files with statOnly). Paths excluded by .dvalincodeignore are left out of the diff.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,
  policyTargets: input => (input.filePath ? [{ kind: 'path', value: input.filePath }] : []),

  async run(input, context) {
    const patterns = await loadIgnorePatterns(context.cwd);
    const args = ['show', '--no-color', '--no-ext-diff', '--no-textconv', '--no-show-signature', '--format=fuller', '--date=iso'];
    if (input.statOnly) args.push('--stat');
    args.push('--end-of-options', assertRevision(input.ref), '--');
    if (input.filePath) args.push(`:(literal)${await workspaceGitPath(context.cwd, input.filePath, patterns)}`);
    args.push(...excludePathspecs(patterns));

    const { stdout, truncated } = await gitRead(args, context.cwd, input.maxBytes);
    const notes = [
      truncated ? `[output truncated at ${input.maxBytes} bytes; narrow it with filePath or statOnly]` : '',
      patterns.length > 0 ? '[paths excluded by .dvalincodeignore are not shown]' : '',
    ].filter(Boolean);
    return {
      title: `git show ${input.ref}`,
      output: [stdout.trimEnd(), ...notes].filter(Boolean).join('\n'),
      metadata: { ref: input.ref, filePath: input.filePath, statOnly: input.statOnly, truncated },
    };
  },
};
