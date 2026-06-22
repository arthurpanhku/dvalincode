import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { generateDiff, formatDiff } from '../core/diffPreview.js';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { sha256 } from '../audit/hash.js';
import { countDiffLines } from '../audit/diffStat.js';
import type { Tool, ReverseOp, ToolResult } from './types.js';

const inputSchema = z
  .object({
    filePath: z.string().min(1),
    oldString: z.string().describe('Exact text to replace'),
    newString: z.string().describe('Replacement text'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const editFileTool: Tool<Input> = {
  name: 'edit_file',
  description: 'Replace exact text in a file. Reports a diff of the change.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  policyTargets: input => [{ kind: 'path', value: input.filePath }],

  isUndoable: () => true,

  reverse(input: Input, _result: ToolResult): ReverseOp | undefined {
    return {
      toolName: 'edit_file',
      input: {
        filePath: input.filePath,
        oldString: input.newString,
        newString: input.oldString,
      },
      description: `Undo edit_file: revert "${input.filePath}" — swap back "${input.newString.slice(0, 40)}…" → "${input.oldString.slice(0, 40)}…"`,
    };
  },
  async run(input, context) {
    const filePath = await resolveInsideWorkspace(context.cwd, input.filePath);

    const existing = await readFile(filePath, 'utf8');

    const idx = existing.indexOf(input.oldString);
    if (idx === -1) {
      throw new Error(`Could not find oldString in ${input.filePath}`);
    }

    const before =
      input.oldString.length > 60
        ? input.oldString.slice(0, 60) + '…'
        : input.oldString;

    const occurrences = existing.split(input.oldString).length - 1;

    const updated = existing.replace(input.oldString, input.newString);

    const diff = generateDiff(existing, updated);
    const output = [`Replaced: "${before}"`, '', formatDiff(diff)].join('\n');

    await writeFile(filePath, updated, 'utf8');

    const stat = countDiffLines(diff);

    return {
      title: `Edit ${input.filePath}`,
      output,
      metadata: {
        path: input.filePath,
        bytesBefore: Buffer.byteLength(existing, 'utf8'),
        bytesAfter: Buffer.byteLength(updated, 'utf8'),
        occurrences,
        diff,
        added: stat.added,
        removed: stat.removed,
        beforeHash: sha256(existing),
        afterHash: sha256(updated),
      },
    };
  },
};
