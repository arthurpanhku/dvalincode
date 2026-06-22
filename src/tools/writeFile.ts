import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { generateDiff, formatDiff } from '../core/diffPreview.js';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { sha256, hashContent } from '../audit/hash.js';
import { countDiffLines, lineCount } from '../audit/diffStat.js';
import type { Tool, ReverseOp, ToolResult } from './types.js';

const inputSchema = z
  .object({
    filePath: z.string().min(1),
    content: z.string(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const writeFileTool: Tool<Input> = {
  name: 'write_file',
  description: 'Write content to a file inside the workspace. Reports a diff if the file already exists.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  policyTargets: input => [{ kind: 'path', value: input.filePath }],

  isUndoable: () => true,

  reverse(input: Input, result: ToolResult): ReverseOp | undefined {
    const existed = result.metadata?.existed === true;
    const originalContent = result.metadata?.originalContent as string | undefined;

    if (existed && originalContent !== undefined) {
      // Restore original content
      return {
        toolName: 'write_file',
        input: { filePath: input.filePath, content: originalContent },
        description: `Undo write_file: restore original content of "${input.filePath}"`,
      };
    }

    if (!existed) {
      // File was new — delete it
      return {
        toolName: 'delete_file',
        input: { filePath: input.filePath },
        description: `Undo write_file: delete newly created file "${input.filePath}"`,
      };
    }

    // Existed but no backup available (shouldn't happen with current code)
    return undefined;
  },

  async run(input, context) {
    const filePath = await resolveInsideWorkspace(context.cwd, input.filePath);

    let output: string;
    let originalContent: string | undefined;
    let diff: ReturnType<typeof generateDiff> | undefined;
    const exists = await fileExists(filePath);

    if (exists) {
      originalContent = await readFile(filePath, 'utf8');
      diff = generateDiff(originalContent, input.content);
      output = formatDiff(diff);
    } else {
      await mkdir(path.dirname(filePath), { recursive: true });
      output = `Created new file: ${input.filePath}`;
    }

    await writeFile(filePath, input.content, 'utf8');

    const stat = exists
      ? countDiffLines(diff)
      : { added: lineCount(input.content), removed: 0 };

    return {
      title: `Write ${input.filePath}`,
      output,
      metadata: {
        path: input.filePath,
        bytes: Buffer.byteLength(input.content, 'utf8'),
        existed: exists,
        originalContent,  // kept for undo; stripped before WebSocket send
        diff,
        added: stat.added,
        removed: stat.removed,
        beforeHash: hashContent(originalContent),
        afterHash: sha256(input.content),
      },
    };
  },
};

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}
