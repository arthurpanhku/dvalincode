import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../core/workspace.js';
import type { Tool } from './types.js';

const execAsync = promisify(execFile);

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
    const args = ['diff'];
    if (input.staged) args.push('--cached');
    if (input.filePath) {
      const resolved = await resolveInsideWorkspace(context.cwd, input.filePath);
      args.push('--', path.relative(context.cwd, resolved));
    }

    try {
      const { stdout } = await execAsync('git', args, {
        cwd: context.cwd,
        maxBuffer: input.maxBytes + 16_000,
      });
      const diff = truncate(stdout.trimEnd(), input.maxBytes);
      return {
        title: 'git diff',
        output: diff || 'No diff.',
        metadata: {
          staged: input.staged,
          filePath: input.filePath,
          truncated: stdout.length > input.maxBytes,
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

function truncate(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  return `${text.slice(0, maxBytes)}\n[diff truncated at ${maxBytes} bytes]`;
}
