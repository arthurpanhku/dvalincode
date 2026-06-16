import { z } from 'zod';
import { updateMemoryEntry } from '../memory/store.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    id: z.string().min(1),
    content: z.string().min(1).max(2_000).optional(),
    kind: z.enum(['preference', 'project_fact', 'decision', 'workflow', 'lesson', 'note']).optional(),
    tags: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const memoryUpdateTool: Tool<Input> = {
  name: 'memory_update',
  description: 'Update an existing local memory entry by id. Use to correct stale or imprecise memories.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  isUndoable: () => false,

  async run(input, context) {
    const updated = await updateMemoryEntry({
      id: input.id,
      cwd: context.cwd,
      content: input.content,
      kind: input.kind,
      tags: input.tags,
      confidence: input.confidence,
    });
    if (!updated) {
      return { title: 'memory_update', output: `Memory not found: ${input.id}` };
    }
    return {
      title: 'memory_update',
      output: `Updated memory ${updated.id}.`,
      metadata: { entry: updated },
    };
  },
};
