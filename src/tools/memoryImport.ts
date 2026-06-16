import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { importMemory } from '../memory/importers.js';
import { dvalinHome } from '../memory/store.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    source: z.enum(['claude', 'hermes', 'markdown']),
    path: z.string().min(1).optional(),
    scope: z.enum(['user', 'project']).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const memoryImportTool: Tool<Input> = {
  name: 'memory_import',
  description: 'Import memory from Claude Code, Hermes, or a Markdown file/directory into DvalinCode local memory. Use dryRun first to preview candidates.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  isUndoable: () => false,

  async run(input, context) {
    const sourcePath = input.path ? await resolveAllowedImportPath(input.path, context.cwd) : undefined;
    const result = await importMemory({
      source: input.source,
      sourcePath,
      cwd: context.cwd,
      scope: input.scope,
      dryRun: input.dryRun,
    });

    const preview = result.candidates.slice(0, 12).map((candidate, index) => {
      const tags = candidate.tags && candidate.tags.length > 0 ? ` #${candidate.tags.join(' #')}` : '';
      return `${index + 1}. (${candidate.kind ?? 'note'}) ${candidate.content}${tags}`;
    }).join('\n\n');

    return {
      title: 'memory_import',
      output: [
        input.dryRun
          ? `Found ${result.candidates.length} candidate memory entr${result.candidates.length === 1 ? 'y' : 'ies'} from ${input.source}.`
          : `Imported ${result.imported} memory entr${result.imported === 1 ? 'y' : 'ies'} from ${input.source}. Skipped ${result.skipped}.`,
        preview ? `\nPreview:\n${preview}` : '',
      ].filter(Boolean).join('\n'),
      metadata: result,
    };
  },
};

async function resolveAllowedImportPath(inputPath: string, cwd: string): Promise<string> {
  const resolved = await realpath(path.resolve(cwd, inputPath));
  const roots = await Promise.all([
    realpath(cwd),
    realpath(path.join(homedir(), '.claude')).catch(() => ''),
    realpath(path.join(homedir(), '.hermes')).catch(() => ''),
    realpath(dvalinHome()).catch(() => ''),
  ]);
  if (!roots.filter(Boolean).some(root => isInside(root, resolved))) {
    throw new Error(`Import path is outside allowed memory locations: ${inputPath}`);
  }
  return resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
