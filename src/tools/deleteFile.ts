import { unlink, stat, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { hashContent } from '../audit/hash.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    filePath: z.string().min(1),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const deleteFileTool: Tool<Input> = {
  name: 'delete_file',
  description: 'Delete a file inside the workspace. Used internally by undo for file removal.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  policyTargets: input => [{ kind: 'path', value: input.filePath }],
  isUndoable: () => false, // Can't undo a delete (no backup)

  async run(input, context) {
    const filePath = await resolveInsideWorkspace(context.cwd, input.filePath);
    await stat(filePath); // throws if not exists

    // Hash the content before removal so the audit trail can record what was deleted.
    let beforeHash: string | null = null;
    try {
      beforeHash = hashContent(await readFile(filePath, 'utf8'));
    } catch {
      beforeHash = null; // binary or unreadable — record the deletion without a hash
    }

    await unlink(filePath);

    return {
      title: `Deleted ${input.filePath}`,
      output: `Deleted file: ${input.filePath}`,
      metadata: { path: input.filePath, beforeHash },
    };
  },
};
