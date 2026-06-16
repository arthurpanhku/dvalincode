import { z } from 'zod';
import { addMemoryEntry } from '../memory/store.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    scope: z.enum(['user', 'project']).default('project'),
    kind: z.enum(['preference', 'project_fact', 'decision', 'workflow', 'lesson', 'note']).default('note'),
    content: z.string().min(1).max(2_000),
    tags: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1).default(0.7),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const memoryWriteTool: Tool<Input> = {
  name: 'memory_write',
  description: 'Store a curated local memory entry. Use for durable preferences, project facts, decisions, workflows, or lessons worth carrying into future sessions.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  isUndoable: () => false,

  async run(input, context) {
    const entry = await addMemoryEntry({
      scope: input.scope,
      cwd: context.cwd,
      kind: input.kind,
      content: input.content,
      tags: input.tags,
      source: 'agent',
      confidence: input.confidence,
    });

    return {
      title: 'memory_write',
      output: `Saved memory ${entry.id} (${entry.scope}/${entry.kind}).`,
      metadata: { entry },
    };
  },
};
