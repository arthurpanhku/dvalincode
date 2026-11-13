import { z } from 'zod';
import { assertRevision, gitRead, workspaceGitPath } from '../core/gitRead.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import type { Tool } from './types.js';

const MAX_LINES = 500;

const inputSchema = z
  .object({
    filePath: z.string().min(1),
    startLine: z.number().int().positive().default(1),
    endLine: z.number().int().positive().optional().describe('Last line to include (default: 200 lines from startLine).'),
    ref: z.string().min(1).max(200).optional().describe('Blame the file as of this commit (default: the working tree).'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const gitBlameTool: Tool<Input> = {
  name: 'git_blame',
  description:
    'Show which commit, author, and date last changed each line of a file, for a range of up to 500 lines. Use it to find the commit behind a line, then git_show to read it.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,
  policyTargets: input => [{ kind: 'path', value: input.filePath }],

  async run(input, context) {
    const endLine = input.endLine ?? input.startLine + 199;
    if (endLine < input.startLine) throw new Error('endLine must not be before startLine.');
    if (endLine - input.startLine + 1 > MAX_LINES) throw new Error(`Blame at most ${MAX_LINES} lines at a time.`);

    const patterns = await loadIgnorePatterns(context.cwd);
    const relative = await workspaceGitPath(context.cwd, input.filePath, patterns);
    // blame takes the revision before "--" and does not honor --end-of-options;
    // assertRevision has already refused anything that starts with a dash.
    const args = ['blame', '--no-textconv', '--date=short', '-L', `${input.startLine},${endLine}`];
    if (input.ref) args.push(assertRevision(input.ref));
    args.push('--', relative);

    const { stdout, truncated } = await gitRead(args, context.cwd, 128_000);
    return {
      title: `git blame ${input.filePath}`,
      output: stdout.trimEnd() + (truncated ? '\n[output truncated; blame a smaller range]' : ''),
      metadata: { filePath: input.filePath, startLine: input.startLine, endLine, ref: input.ref },
    };
  },
};
