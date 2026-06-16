import { z } from 'zod';
import { searchMemory } from '../memory/store.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    query: z.string().default(''),
    scopes: z.array(z.enum(['user', 'project'])).optional(),
    maxResults: z.number().int().positive().max(20).default(8),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const memorySearchTool: Tool<Input> = {
  name: 'memory_search',
  description: 'Search local user/project memory for preferences, project facts, decisions, workflows, and lessons.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  isUndoable: () => false,

  async run(input, context) {
    const results = await searchMemory(input.query, {
      cwd: context.cwd,
      scopes: input.scopes,
      maxResults: input.maxResults,
    });

    if (results.length === 0) {
      return { title: 'memory_search', output: 'No matching memory entries.' };
    }

    const output = results.map((entry, index) => {
      const tags = entry.tags.length > 0 ? ` #${entry.tags.join(' #')}` : '';
      return [
        `${index + 1}. ${entry.id} (${entry.scope}/${entry.kind}, score ${entry.score})${tags}`,
        `   ${entry.content}`,
      ].join('\n');
    }).join('\n\n');

    return {
      title: 'memory_search',
      output,
      metadata: { entries: results },
    };
  },
};
