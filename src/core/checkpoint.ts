import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from '../audit/hash.js';
import { gitRead } from './gitRead.js';
import { resolveInsideWorkspace, resolveRelativeInside, resolveWorkspaceRoot } from './workspace.js';
import { isIgnoredPath, loadIgnorePatterns } from './ignorefile.js';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 10_000;
const runIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{12}$/;
const stateSchema = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), mode: z.number().int().min(0).max(0o777) }).strict();
const manifestSchema = z.object({
  root: z.string(),
  changes: z.array(z.object({ filePath: z.string(), before: stateSchema.nullable(), after: stateSchema.nullable() }).strict()).max(MAX_FILES * 2),
}).strict();
export type FileState = z.infer<typeof stateSchema>;
export type Checkpoint = z.infer<typeof manifestSchema>;
export type CheckpointStatus = { changed: number } | { unavailable: string };

function storage(): string {
  return path.join(process.env.DVALINCODE_HOME ?? path.join(homedir(), '.dvalincode'), 'checkpoints');
}

function runDirectory(runId: string): string {
  if (!runIdPattern.test(runId)) throw new Error('Invalid checkpoint run ID');
  // The pattern already rules out separators and "..". Resolving and checking
  // containment as well keeps that true if the pattern ever loosens, and is the
  // form static analysis recognizes (the run ID arrives in an HTTP request).
  const base = path.resolve(storage());
  const directory = path.resolve(base, runId);
  if (!directory.startsWith(base + path.sep)) throw new Error('Invalid checkpoint run ID');
  return directory;
}

export async function checkpointPath(root: string, relative: string): Promise<string> {
  const target = resolveRelativeInside(root, relative);
  if (path.relative(root, target).split(path.sep).some(part => !part || part.toLowerCase() === '.git') ||
      await resolveInsideWorkspace(root, relative) !== target) throw new Error(`Unsafe checkpoint path: ${relative}`);
  return target;
}

export async function readCheckpointFile(target: string, maxBytes = MAX_BYTES): Promise<{ state: FileState; bytes: Buffer } | null> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Checkpoint requires a regular file');
    if (stat.size > maxBytes) throw new Error('Checkpoint exceeds its file size limit');
    const fd = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const current = await fd.stat();
      if (!current.isFile() || current.nlink !== 1 || current.size > maxBytes) throw new Error('Checkpoint file changed while opening');
      const bytes = await fd.readFile();
      if (bytes.length > maxBytes) throw new Error('Checkpoint exceeds its file size limit');
      return { state: { hash: sha256(bytes), mode: current.mode & 0o777 }, bytes };
    } finally {
      await fd.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function sameFileState(a: FileState | null, b: FileState | null): boolean {
  return a?.hash === b?.hash && a?.mode === b?.mode;
}

export async function startCheckpoint(cwd: string, runId: string, include: (file: string) => boolean) {
  const root = await resolveWorkspaceRoot(cwd);
  const directory = runDirectory(runId);
  await mkdir(storage(), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  let before: Map<string, FileState>;
  try {
    before = await capture(root, include, async ({ state, bytes }) => {
      try {
        await writeFile(path.join(directory, state.hash), bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return async (): Promise<CheckpointStatus> => {
    const after = await capture(root, include).catch(async error => {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    });
    const changes: Checkpoint['changes'] = [];
    for (const filePath of new Set([...before.keys(), ...after.keys()])) {
      const prior = before.get(filePath) ?? null;
      const next = after.get(filePath) ?? null;
      if (!sameFileState(prior, next)) changes.push({ filePath, before: prior, after: next });
    }
    const used = new Set(changes.flatMap(change => change.before ? [change.before.hash] : []));
    for (const file of await readdir(directory)) {
      if (!used.has(file)) await rm(path.join(directory, file));
    }
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ root, changes }), { flag: 'wx', mode: 0o600 });
    return { changed: changes.length };
  };
}

async function capture(
  root: string,
  include: (file: string) => boolean,
  store?: (file: { state: FileState; bytes: Buffer }) => Promise<void>,
): Promise<Map<string, FileState>> {
  const top = await gitRead(['rev-parse', '--show-toplevel'], root, 8192);
  if (top.truncated || await resolveWorkspaceRoot(top.stdout.trim()) !== root) throw new Error('Checkpoint requires the Git workspace root');
  const listing = await gitRead(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, 4 * 1024 * 1024);
  if (listing.truncated) throw new Error('Checkpoint file listing exceeded its limit');
  const ignore = await loadIgnorePatterns(root);
  const files = new Set(listing.stdout.split('\0').filter(file => file && include(file) && !isIgnoredPath(file, ignore)));
  if (files.size > MAX_FILES) throw new Error('Checkpoint exceeds its file count limit');
  const result = new Map<string, FileState>();
  let bytes = 0;
  for (const file of files) {
    const target = await checkpointPath(root, file);
    const current = await readCheckpointFile(target, MAX_BYTES - bytes);
    if (!current) continue;
    bytes += current.bytes.length;
    await store?.(current);
    result.set(file, current.state);
  }
  return result;
}

export async function loadCheckpoint(runId: string): Promise<Checkpoint> {
  return manifestSchema.parse(JSON.parse(await readFile(path.join(runDirectory(runId), 'manifest.json'), 'utf8')));
}

export async function readCheckpointBlob(runId: string, state: FileState): Promise<Buffer> {
  const blob = await readCheckpointFile(path.join(runDirectory(runId), state.hash));
  if (!blob || blob.state.hash !== state.hash) throw new Error('Checkpoint backup failed integrity verification');
  return blob.bytes;
}

export async function listCheckpoints(): Promise<Array<{ runId: string; root: string; changed: number }>> {
  const dirs = await readdir(storage()).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const results = [];
  for (const runId of dirs.filter(dir => runIdPattern.test(dir)).sort().reverse()) {
    const manifest = await loadCheckpoint(runId).catch(() => undefined);
    if (manifest) results.push({ runId, root: manifest.root, changed: manifest.changes.length });
  }
  return results;
}
