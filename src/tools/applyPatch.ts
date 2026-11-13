import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../audit/hash.js';
import { countDiffLines } from '../audit/diffStat.js';
import { generateDiff, formatDiff } from '../core/diffPreview.js';
import { isIgnoredPath, loadIgnorePatterns } from '../core/ignorefile.js';
import { assertNoRedactionWriteBack } from '../core/redactSecrets.js';
import { resolveInsideWorkspace, resolveRelativeInside, resolveWorkspaceRoot } from '../core/workspace.js';
import type { Tool } from './types.js';

const patch = z.object({
  filePath: z.string().min(1),
  oldString: z.string(),
  newString: z.string(),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const schema = z.object({ files: z.array(patch).min(2).max(20) }).strict();
type Input = z.infer<typeof schema>;
type Change = {
  filePath: string;
  target: string;
  before: string;
  after: string;
  mode: number;
  beforeHash: string;
  afterHash: string;
  output: string;
  added: number;
  removed: number;
};

export const applyPatchTool: Tool<Input> = {
  name: 'apply_patch',
  description: 'Apply exact text replacements across multiple existing files. Every file and match is checked before any changes.',
  access: 'write',
  inputSchema: schema,
  policyTargets: input => input.files.map(({ filePath }) => ({ kind: 'path', value: filePath })),
  isUndoable: () => true,
  reverse(_input, result) {
    const files = result.metadata?.originalContent;
    if (!Array.isArray(files)) return;
    return { toolName: 'apply_patch', input: { files }, description: 'Restore files changed by apply_patch' };
  },
  async run(input, context) {
    const root = await resolveWorkspaceRoot(context.cwd);
    const ignored = await loadIgnorePatterns(root);
    const targets = new Set<string>();
    const changes: Change[] = [];
    for (const file of input.files) {
      const lexical = resolveRelativeInside(root, file.filePath);
      const target = await resolveInsideWorkspace(root, file.filePath);
      const relative = path.relative(root, target);
      if (target !== lexical || !relative || relative.split(path.sep).join('/') !== file.filePath ||
          relative.split(path.sep).some(part => part.toLowerCase() === '.git') || isIgnoredPath(relative, ignored)) {
        throw new Error(`Patch requires a regular workspace file: ${file.filePath}`);
      }
      const info = await lstat(target);
      if (!info.isFile() || info.nlink !== 1 || info.size > context.maxBytes) {
        throw new Error(`Patch requires a regular file within the size limit: ${file.filePath}`);
      }
      if (targets.has(target)) throw new Error(`Duplicate patch path: ${file.filePath}`);
      targets.add(target);
      const bytes = await readFile(target);
      const before = bytes.toString('utf8');
      if (bytes.length > context.maxBytes || !Buffer.from(before).equals(bytes) || before.includes('\0')) {
        throw new Error(`Patch requires UTF-8 text within the size limit: ${file.filePath}`);
      }
      const beforeHash = sha256(before);
      if (file.expectedHash && beforeHash !== file.expectedHash) throw new Error(`File changed since the patch: ${file.filePath}`);
      // A hash-bound undo replaces the entire file and may restore an empty file.
      let after: string;
      if (file.expectedHash) {
        if (file.oldString !== before) throw new Error(`File content no longer matches: ${file.filePath}`);
        after = file.newString;
      } else {
        const index = before.indexOf(file.oldString);
        if (!file.oldString || index < 0 || before.indexOf(file.oldString, index + 1) >= 0) {
          throw new Error(`Expected exactly one match in ${file.filePath}`);
        }
        after = before.slice(0, index) + file.newString + before.slice(index + file.oldString.length);
      }
      if (Buffer.byteLength(after) > context.maxBytes || after.includes('\0')) throw new Error(`Patched text exceeds limits: ${file.filePath}`);
      // Checked for every file before any is staged, so the patch stays all or nothing.
      assertNoRedactionWriteBack(before, after, file.filePath);
      const diff = generateDiff(before, after);
      changes.push({ filePath: file.filePath, target, before, after, beforeHash, afterHash: sha256(after), mode: info.mode & 0o777,
        output: formatDiff(diff), ...countDiffLines(diff) });
    }

    const staged = new Map<Change, { next: string; backup: string }>();
    const temporaryFiles: string[] = [];
    const committed: Change[] = [];
    const recoveryFiles = new Set<string>();
    try {
      for (const change of changes) {
        const base = path.join(path.dirname(change.target), `.dvalin-patch-${randomUUID()}`);
        const next = `${base}.next`;
        const backup = `${base}.backup`;
        await writeFile(next, change.after, { flag: 'wx', mode: change.mode });
        temporaryFiles.push(next);
        await chmod(next, change.mode);
        await writeFile(backup, change.before, { flag: 'wx', mode: 0o600 });
        temporaryFiles.push(backup);
        staged.set(change, { next, backup });
      }
      for (const change of changes) {
        if (context.signal?.aborted) throw new Error('interrupted');
        const resolved = await resolveInsideWorkspace(root, change.filePath);
        const current = await lstat(resolved);
        if (resolved !== change.target || !current.isFile() || current.nlink !== 1 ||
            (current.mode & 0o777) !== change.mode || sha256(await readFile(resolved)) !== change.beforeHash) {
          throw new Error(`File changed while staging patch: ${change.filePath}`);
        }
        await rename(staged.get(change)!.next, change.target);
        committed.push(change);
      }
    } catch (error) {
      for (const change of committed.reverse()) {
        const { backup } = staged.get(change)!;
        try {
          const resolved = await resolveInsideWorkspace(root, change.filePath);
          if (resolved !== change.target || sha256(await readFile(resolved, 'utf8')) !== change.afterHash) {
            throw new Error('File changed during patch');
          }
          await chmod(backup, change.mode);
          await rename(backup, change.target);
        } catch {
          recoveryFiles.add(backup);
        }
      }
      if (recoveryFiles.size) throw new Error(`Patch could not restore all files. Recovery copies: ${[...recoveryFiles].map(file => path.relative(root, file)).join(', ')}`);
      throw error;
    } finally {
      await Promise.allSettled(temporaryFiles.filter(file => !recoveryFiles.has(file)).map(file => unlink(file)));
    }

    return {
      title: `Patched ${changes.length} files`,
      output: changes.map(change => `${change.filePath}\n${change.output}`).join('\n\n'),
      metadata: {
        files: changes.map(({ filePath, beforeHash, afterHash, added, removed }) => ({ filePath, beforeHash, afterHash, added, removed })),
        originalContent: changes.map(change => ({
          filePath: change.filePath, oldString: change.after, newString: change.before, expectedHash: change.afterHash,
        })),
      },
    };
  },
};
