import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkpointPath, loadCheckpoint, readCheckpointBlob, readCheckpointFile, sameFileState, type Checkpoint } from '../core/checkpoint.js';
import { isIgnoredPath, loadIgnorePatterns } from '../core/ignorefile.js';
import { resolveWorkspaceRoot } from '../core/workspace.js';
import type { DvalinContext } from '../core/context.js';
import { ToolRegistry } from './registry.js';

const inputSchema = z.object({ runId: z.string() }).strict();
const activeRollbacks = new Set<string>();

async function restoreCheckpoint(runId: string, manifest: Checkpoint, context: DvalinContext) {
  const root = await resolveWorkspaceRoot(context.cwd);
  if (root !== manifest.root) throw new Error('Checkpoint belongs to another workspace');
  const ignore = await loadIgnorePatterns(root);
  const staged: Array<{ change: Checkpoint['changes'][number]; target: string; restore?: string; backup?: string }> = [];
  const temporary = new Set<string>();
  const committed: typeof staged = [];
  const recovery: string[] = [];
  const createdDirectories = new Set<string>();
  const stage = async (target: string, bytes: Buffer, mode: number): Promise<string> => {
    const directory = await existingParent(path.dirname(target), root);
    const file = path.join(directory, `.dvalin-rollback-${randomUUID()}`);
    await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    temporary.add(file);
    await chmod(file, mode);
    return file;
  };
  const paths = new Set<string>();
  try {
    for (const change of manifest.changes) {
      const target = await checkpointPath(root, change.filePath);
      if (paths.has(target) || path.relative(root, target).split(path.sep).join('/') !== change.filePath ||
          isIgnoredPath(change.filePath, ignore)) throw new Error(`Checkpoint path is unavailable: ${change.filePath}`);
      paths.add(target);
      const current = await readCheckpointFile(target);
      if (!sameFileState(current?.state ?? null, change.after)) throw new Error(`Rollback conflict: ${change.filePath}`);
      const item: typeof staged[number] = { change, target };
      if (change.before) item.restore = await stage(target, await readCheckpointBlob(runId, change.before), change.before.mode);
      if (current) item.backup = await stage(target, current.bytes, current.state.mode);
      staged.push(item);
    }
    for (const item of staged) {
      if (context.signal?.aborted) throw new Error('interrupted');
      const target = await checkpointPath(root, item.change.filePath);
      if (!sameFileState((await readCheckpointFile(target))?.state ?? null, item.change.after)) {
        throw new Error(`Rollback conflict: ${item.change.filePath}`);
      }
      if (item.restore) {
        const parent = path.dirname(target);
        const existing = await existingParent(parent, root);
        let directory = existing;
        if (parent !== existing) {
          for (const part of path.relative(existing, parent).split(path.sep)) {
            directory = path.join(directory, part);
            await mkdir(directory);
            createdDirectories.add(directory);
          }
        }
        await checkpointPath(root, item.change.filePath);
        await rename(item.restore, target);
      } else if (item.change.after) {
        await unlink(target);
      }
      committed.push(item);
    }
  } catch (error) {
    for (const item of committed.reverse()) {
      try {
        const target = await checkpointPath(root, item.change.filePath);
        if (!sameFileState((await readCheckpointFile(target))?.state ?? null, item.change.before)) throw new Error('Conflict');
        if (item.backup) await rename(item.backup, target);
        else if (item.change.before) await unlink(target);
      } catch {
        recovery.push(item.backup ?? item.target);
        if (item.backup) temporary.delete(item.backup);
      }
    }
    for (const directory of [...createdDirectories].reverse()) await rmdir(directory).catch(() => undefined);
    if (recovery.length) throw new Error(`Rollback was interrupted. Inspect recovery paths: ${recovery.join(', ')}`);
    throw error;
  } finally {
    await Promise.allSettled([...temporary].map(file => unlink(file)));
  }
  context.audit?.append({ type: 'run_rollback', sourceRunId: runId, files: committed.length });
  return { title: 'Run rollback', output: `Restored ${committed.length} file(s) from run ${runId}.` };
}

export async function createRollbackRegistry(runId: string) {
  const manifest = await loadCheckpoint(runId);
  const registry = new ToolRegistry();
  registry.register({
    name: 'rollback_run',
    description: 'Restore covered files from a previous workspace checkpoint when they still match the end of that run.',
    access: 'write',
    inputSchema: inputSchema.refine(input => input.runId === runId, 'Checkpoint ID mismatch'),
    policyTargets: () => manifest.changes.map(({ filePath }) => ({ kind: 'path', value: filePath })),
    async run(_input, context) {
      const root = await resolveWorkspaceRoot(context.cwd);
      if (activeRollbacks.has(root)) throw new Error('A rollback is already in progress for this workspace');
      activeRollbacks.add(root);
      try {
        return await restoreCheckpoint(runId, manifest, context);
      } finally {
        activeRollbacks.delete(root);
      }
    },
  });
  return { registry, root: manifest.root };
}

async function existingParent(directory: string, root: string): Promise<string> {
  while (directory !== root) {
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error('Checkpoint parent must be a regular directory');
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      directory = path.dirname(directory);
    }
  }
  return root;
}
