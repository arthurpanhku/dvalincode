import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { exportData, importData, isDataBundle, type DataBundle } from '../data/archive.js';
import { loadSession } from '../sessions/store.js';
import { renderSessionMarkdown } from '../sessions/markdown.js';

export function registerDataCommands(program: Command): void {
  program
    .command('export')
    .description('Export all local DvalinCode data (config, sessions, memory, audit) to a portable file')
    .option('--out <file>', 'output path (default: dvalincode-export-<timestamp>.json)')
    .option('--no-audit', 'exclude the audit/ run logs from the bundle')
    .action(async (opts: { out?: string; audit: boolean }) => {
      const bundle = await exportData({ includeAudit: opts.audit });
      const fileCount = Object.keys(bundle.files).length;
      const out = opts.out ?? `dvalincode-export-${bundle.exportedAt.replace(/[:.]/g, '-')}.json`;
      const target = path.resolve(process.cwd(), out);
      await writeFile(target, JSON.stringify(bundle), 'utf-8');
      console.log(`Exported ${fileCount} files → ${target}`);
    });

  program
    .command('import')
    .description('Restore local DvalinCode data from a file created by `dvalincode export`')
    .argument('<file>', 'bundle file to import')
    .option('--no-overwrite', 'keep existing files instead of overwriting them')
    .action(async (file: string, opts: { overwrite: boolean }) => {
      const raw = await readFile(path.resolve(process.cwd(), file), 'utf-8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('File is not valid JSON — expected a DvalinCode export bundle.');
      }
      if (!isDataBundle(parsed)) {
        throw new Error('Not a DvalinCode export bundle.');
      }
      const result = await importData(parsed as DataBundle, { overwrite: opts.overwrite });
      console.log(
        `Imported ${result.written} files (skipped ${result.skipped} of ${result.total}). Restart DvalinCode to pick up changes.`,
      );
    });

  const session = program
    .command('session')
    .description('Work with saved sessions');

  session
    .command('md')
    .description('Render a saved session as a Markdown transcript')
    .argument('<id>', 'session id')
    .option('--out <file>', 'write to a file instead of stdout')
    .action(async (id: string, opts: { out?: string }) => {
      const loaded = await loadSession(id);
      if (!loaded) {
        console.error(`Session not found: ${id}`);
        process.exit(1);
      }
      const md = renderSessionMarkdown(loaded);
      if (opts.out) {
        const target = path.resolve(process.cwd(), opts.out);
        await writeFile(target, md, 'utf-8');
        console.log(`Wrote transcript → ${target}`);
      } else {
        process.stdout.write(md);
      }
    });
}
