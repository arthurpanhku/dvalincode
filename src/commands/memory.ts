import path from 'node:path';
import type { Command } from 'commander';
import { importMemory, type MemoryImportSource } from '../memory/importers.js';
import { listMemoryEntries, searchMemory, type MemoryScope } from '../memory/store.js';

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command('memory')
    .description('Inspect and import local DvalinCode memory');

  memory
    .command('list')
    .description('List stored memory entries')
    .option('--scope <scope>', 'user or project')
    .option('--cwd <path>', 'workspace path', '.')
    .action(async (opts: { scope?: MemoryScope; cwd: string }) => {
      const entries = await listMemoryEntries({
        cwd: path.resolve(process.cwd(), opts.cwd),
        scopes: opts.scope ? [opts.scope] : undefined,
      });
      if (entries.length === 0) {
        console.log('No memory entries.');
        return;
      }
      for (const entry of entries) {
        console.log(`${entry.id} (${entry.scope}/${entry.kind}) ${entry.content}`);
      }
    });

  memory
    .command('search')
    .description('Search stored memory entries')
    .argument('<query>', 'query text')
    .option('--scope <scope>', 'user or project')
    .option('--cwd <path>', 'workspace path', '.')
    .option('--max <n>', 'maximum results', '8')
    .action(async (query: string, opts: { scope?: MemoryScope; cwd: string; max: string }) => {
      const results = await searchMemory(query, {
        cwd: path.resolve(process.cwd(), opts.cwd),
        scopes: opts.scope ? [opts.scope] : undefined,
        maxResults: Number.parseInt(opts.max, 10) || 8,
      });
      if (results.length === 0) {
        console.log('No matching memory entries.');
        return;
      }
      for (const entry of results) {
        console.log(`${entry.id} (${entry.scope}/${entry.kind}, score ${entry.score}) ${entry.content}`);
      }
    });

  memory
    .command('import')
    .description('Import memory from Claude Code, Hermes, or Markdown')
    .argument('<source>', 'claude, hermes, or markdown')
    .option('--path <path>', 'source file or directory')
    .option('--scope <scope>', 'user or project')
    .option('--cwd <path>', 'workspace path', '.')
    .option('--dry-run', 'preview candidate entries without saving')
    .action(async (source: MemoryImportSource, opts: { path?: string; scope?: MemoryScope; cwd: string; dryRun?: boolean }) => {
      if (!['claude', 'hermes', 'markdown'].includes(source)) {
        throw new Error('source must be claude, hermes, or markdown');
      }
      const result = await importMemory({
        source,
        sourcePath: opts.path ? path.resolve(process.cwd(), opts.path) : undefined,
        cwd: path.resolve(process.cwd(), opts.cwd),
        scope: opts.scope,
        dryRun: opts.dryRun,
      });
      console.log(
        opts.dryRun
          ? `Found ${result.candidates.length} candidate memory entries.`
          : `Imported ${result.imported} memory entries. Skipped ${result.skipped}.`,
      );
      for (const candidate of result.candidates.slice(0, 20)) {
        console.log(`- (${candidate.kind ?? 'note'}) ${candidate.content}`);
      }
    });
}
