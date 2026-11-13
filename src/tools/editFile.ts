import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { generateDiff, formatDiff } from '../core/diffPreview.js';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { sha256 } from '../audit/hash.js';
import { countDiffLines } from '../audit/diffStat.js';
import type { Tool, ReverseOp, ToolResult } from './types.js';

const editSchema = z
  .object({
    oldString: z.string().describe('Exact text to replace. Must occur exactly once unless replaceAll is set.'),
    newString: z.string().describe('Replacement text.'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence of oldString.'),
  })
  .strict();

const inputSchema = z
  .object({
    filePath: z.string().min(1),
    oldString: z.string().optional().describe('Exact text to replace; must occur exactly once unless replaceAll is set. Omit when using edits.'),
    newString: z.string().optional().describe('Replacement text. Omit when using edits.'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence of oldString, e.g. to rename a variable throughout the file.'),
    edits: z
      .array(editSchema)
      .min(1)
      .max(100)
      .optional()
      .describe('Several replacements in one file, applied in order and all or nothing. Use instead of oldString/newString.'),
  })
  .strict()
  .superRefine((input, ctx) => {
    const single = input.oldString !== undefined || input.newString !== undefined || input.replaceAll !== undefined;
    if (input.edits && single) {
      ctx.addIssue({ code: 'custom', message: 'Use either edits or oldString/newString, not both.' });
    } else if (!input.edits && (input.oldString === undefined || input.newString === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Provide oldString and newString, or an edits list.' });
    }
  });

type Input = z.infer<typeof inputSchema>;
type Edit = z.infer<typeof editSchema>;

export const editFileTool: Tool<Input> = {
  name: 'edit_file',
  description:
    'Replace exact text in a file: one replacement (oldString/newString), every occurrence (replaceAll), or several replacements at once (edits). Reports a diff of the change.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  policyTargets: input => [{ kind: 'path', value: input.filePath }],

  isUndoable: () => true,

  reverse(input: Input, result: ToolResult): ReverseOp | undefined {
    // Batches and replaceAll keep the original file, because swapping the strings
    // back would also rewrite text that matched newString before the edit.
    const originalContent = result.metadata?.originalContent;
    if (typeof originalContent === 'string') {
      return {
        toolName: 'write_file',
        input: { filePath: input.filePath, content: originalContent },
        description: `Undo edit_file: restore "${input.filePath}" as it was before the edit`,
      };
    }
    const oldString = input.oldString ?? '';
    const newString = input.newString ?? '';
    return {
      toolName: 'edit_file',
      input: {
        filePath: input.filePath,
        oldString: newString,
        newString: oldString,
      },
      description: `Undo edit_file: revert "${input.filePath}" — swap back "${newString.slice(0, 40)}…" → "${oldString.slice(0, 40)}…"`,
    };
  },
  async run(input, context) {
    const filePath = await resolveInsideWorkspace(context.cwd, input.filePath);
    const existing = await readFile(filePath, 'utf8');

    const batch = input.edits !== undefined;
    const edits: Edit[] = input.edits ?? [
      { oldString: input.oldString ?? '', newString: input.newString ?? '', replaceAll: input.replaceAll },
    ];
    const { updated, replacements } = applyEdits(existing, edits, input.filePath);

    const diff = generateDiff(existing, updated);
    const first = edits[0].oldString;
    const before = first.length > 60 ? first.slice(0, 60) + '…' : first;
    const summary = batch
      ? `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} (${replacements} replacement${replacements === 1 ? '' : 's'})`
      : replacements > 1
        ? `Replaced ${replacements} occurrences of "${before}"`
        : `Replaced: "${before}"`;
    const output = [summary, '', formatDiff(diff)].join('\n');

    await writeFile(filePath, updated, 'utf8');

    const stat = countDiffLines(diff);

    return {
      title: `Edit ${input.filePath}`,
      output,
      metadata: {
        path: input.filePath,
        bytesBefore: Buffer.byteLength(existing, 'utf8'),
        bytesAfter: Buffer.byteLength(updated, 'utf8'),
        occurrences: replacements,
        edits: edits.length,
        diff,
        added: stat.added,
        removed: stat.removed,
        beforeHash: sha256(existing),
        afterHash: sha256(updated),
        // Kept for undo; stripped before WebSocket send.
        ...(batch || input.replaceAll ? { originalContent: existing } : {}),
      },
    };
  },
};

/**
 * Apply `edits` in order to `content`. Each edit sees the result of the ones
 * before it, and any failure throws before anything is written.
 */
function applyEdits(content: string, edits: Edit[], filePath: string): { updated: string; replacements: number } {
  let updated = content;
  let replacements = 0;
  edits.forEach((edit, index) => {
    const label = edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ` : '';
    if (!edit.oldString) {
      throw new Error(`${label}oldString must not be empty; use write_file to replace a whole file.`);
    }

    const occurrences = updated.split(edit.oldString).length - 1;
    if (occurrences === 0) {
      const after = index > 0 ? ' (after the earlier edits were applied)' : '';
      throw new Error(`${label}Could not find oldString in ${filePath}${after}`);
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new Error(
        `${label}oldString matches ${occurrences} places in ${filePath}; include enough surrounding lines to match exactly one, or set replaceAll.`,
      );
    }

    if (edit.replaceAll) {
      updated = updated.split(edit.oldString).join(edit.newString);
      replacements += occurrences;
    } else {
      // Not String.prototype.replace: it would expand `$$`, `$&` and `$'` in newString.
      const idx = updated.indexOf(edit.oldString);
      updated = updated.slice(0, idx) + edit.newString + updated.slice(idx + edit.oldString.length);
      replacements += 1;
    }
  });
  return { updated, replacements };
}
