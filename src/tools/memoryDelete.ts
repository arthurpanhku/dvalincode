import { z } from 'zod';
import { deleteMemoryEntry } from '../memory/store.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    id: z.string().min(1),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const memoryDeleteTool: Tool<Input> = {
  name: 'memory_delete',
  description: 'Delete a stale or incorrect local memory entry by id.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  isUndoable: () => false,

  async run(input, context) {
    const deleted = await deleteMemoryEntry({ id: input.id, cwd: context.cwd });
    return {
      title: 'memory_delete',
      output: deleted ? `Deleted memory ${input.id}.` : `Memory not found: ${input.id}`,
      metadata: { deleted },
    };
  },
};
