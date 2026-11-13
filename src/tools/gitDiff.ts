import { z } from 'zod';
import { excludePathspecs, gitRead, workspaceGitPath } from '../core/gitRead.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    filePath: z.string().min(1).optional(),
    staged: z.boolean().default(false),
    maxBytes: z.number().int().positive().max(128_000).default(64_000),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const gitDiffTool: Tool<Input> = {
  name: 'git_diff',
  description: 'Show the current git diff, optionally scoped to one workspace file. Use before reviewing or summarizing changes.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,

  async run(input, context) {
    try {
      const patterns = await loadIgnorePatterns(context.cwd);
      const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
      if (input.staged) args.push('--cached');
      args.push('--');
      if (input.filePath) args.push(`:(literal)${await workspaceGitPath(context.cwd, input.filePath, patterns)}`);
      args.push(...excludePathspecs(patterns));

      const { stdout, truncated } = await gitRead(args, context.cwd, input.maxBytes);
      const diff = stdout.trimEnd() + (truncated ? `\n[diff truncated at ${input.maxBytes} bytes]` : '');
      return {
        title: 'git diff',
        output: diff || 'No diff.',
        metadata: {
          staged: input.staged,
          filePath: input.filePath,
          truncated,
        },
      };
    } catch (err) {
      return {
        title: 'git diff',
        output: `Unable to read git diff: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};
