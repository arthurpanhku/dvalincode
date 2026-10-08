import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertSafeRef } from './diffScope.js';

const execFileAsync = promisify(execFile);

/**
 * Keep the fix on top of a moving base, inside the loop.
 *
 * The manual version of this is the second half of the pain the loop exists to
 * remove: the agent's patch was written against yesterday's main, the CI
 * scanner runs against today's, and a person rebases, resolves, and pushes
 * again — sometimes reintroducing what the fix removed. Here the rebase happens
 * between the executor's edit and Dvalin's judgement, so every verdict the
 * loop reaches is about the change as it sits on the current base.
 *
 * Mechanics: the executor's uncommitted work is committed as a temporary
 * commit, the branch is rebased with git's own rebase, and the temporary commit
 * is undone again, leaving the work uncommitted on the new base. Conflicts go to
 * the executor — conflicts only, with the files named — and Dvalin, not the
 * executor, continues the rebase. Markers left in a file are a conflict not
 * resolved, whatever the executor says. If they cannot be resolved the rebase is
 * aborted and the tree is left exactly as it was.
 */
export type RebaseResult =
  | { status: 'up-to-date'; base: string }
  | { status: 'rebased'; from: string; to: string; base: string; conflicts: string[] }
  | { status: 'conflict'; files: string[]; detail: string };

export type SyncInput = {
  cwd: string;
  /** The commit the uncommitted work currently sits on. */
  baseCommit: string;
  /** What to rebase onto, e.g. `origin/main`. Fetched first when it names a remote branch. */
  onto: string;
  /** Asked to resolve conflict markers in these files. Must not run git itself; Dvalin continues the rebase. */
  resolveConflicts: (files: string[], attempt: number) => Promise<void>;
  maxConflictRounds: number;
};

const MARKER = /^(?:<{7}|>{7})(?: |$)/m;
const WIP_MESSAGE = 'dvalin: fix in progress (temporary, undone after rebase)';

export async function syncWithUpstream(input: SyncInput): Promise<RebaseResult> {
  assertSafeRef(input.onto);
  await fetchIfRemote(input.cwd, input.onto);
  const target = (await git(input.cwd, ['rev-parse', '--verify', '--quiet', `${input.onto}^{commit}`]).catch(() => '')).trim();
  if (!target) throw new Error(`Cannot resolve rebase target '${input.onto}'.`);

  // Already contains upstream: nothing to do, and nothing to disturb.
  if (await isAncestor(input.cwd, target, input.baseCommit)) return { status: 'up-to-date', base: input.baseCommit };

  await git(input.cwd, ['add', '-A']);
  const hasWork = Boolean((await git(input.cwd, ['diff', '--cached', '--name-only'])).trim());
  if (hasWork) await git(input.cwd, ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-q', '-m', WIP_MESSAGE]);
  const before = (await git(input.cwd, ['rev-parse', 'HEAD'])).trim();

  const conflicts = new Set<string>();
  let stopped = !(await tryGit(input.cwd, ['rebase', '--quiet', target]));
  for (let attempt = 1; stopped && attempt <= input.maxConflictRounds; attempt++) {
    const files = await conflictedFiles(input.cwd);
    files.forEach(file => conflicts.add(file));
    if (files.length) await input.resolveConflicts(files, attempt);
    if (files.length && (await filesWithMarkers(input.cwd, files)).length) continue;
    await git(input.cwd, ['add', '-A']);
    // The next commit in the rebase may stop again; that is another round.
    stopped = !(await tryGit(input.cwd, ['rebase', '--continue']));
  }

  if (stopped) {
    const files = await conflictedFiles(input.cwd);
    const marked = await filesWithMarkers(input.cwd, files);
    await tryGit(input.cwd, ['rebase', '--abort']);
    if (hasWork) await undoWip(input.cwd);
    return {
      status: 'conflict',
      files: [...new Set([...files, ...marked])],
      detail: `rebasing onto ${input.onto} stopped on conflicts that were not resolved in ${input.maxConflictRounds} attempt(s)`,
    };
  }

  // The temporary commit can vanish in the rebase — git drops a commit that
  // became empty because upstream made the same change — so look, don't assume.
  const wipOnTop = (await git(input.cwd, ['log', '-1', '--format=%s'])).trim() === WIP_MESSAGE;
  const base = (await git(input.cwd, ['rev-parse', wipOnTop ? 'HEAD~1' : 'HEAD'])).trim();
  if (wipOnTop) await undoWip(input.cwd);
  return { status: 'rebased', from: before, to: target, base, conflicts: [...conflicts].sort() };
}

export function buildConflictPrompt(onto: string, files: string[], attempt: number): string {
  return [
    `Dvalin rebased your security fix onto ${onto} and the rebase stopped on conflicts (attempt ${attempt}). Resolve them:`,
    ...files.map(file => `- ${file}`),
    '',
    'Edit only these files. Keep both the upstream change and the security fix; if they cannot both stand, keep the fix and say what you dropped.',
    'Remove every conflict marker (<<<<<<<, =======, >>>>>>>). Do not run git — no add, commit, rebase, or checkout. Dvalin continues the rebase and judges the result.',
  ].join('\n');
}

async function undoWip(cwd: string): Promise<void> {
  const subject = (await git(cwd, ['log', '-1', '--format=%s'])).trim();
  if (subject !== WIP_MESSAGE) return;
  await git(cwd, ['reset', '--soft', 'HEAD~1']);
  await git(cwd, ['reset', '-q']);
}

async function fetchIfRemote(cwd: string, onto: string): Promise<void> {
  const remotes = (await git(cwd, ['remote']).catch(() => '')).split('\n').map(line => line.trim()).filter(Boolean);
  const remote = remotes.find(name => onto.startsWith(`${name}/`));
  if (!remote) return;
  // A failed fetch leaves the last fetched ref, which is still a valid target.
  await tryGit(cwd, ['fetch', '--quiet', remote, onto.slice(remote.length + 1)]);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
}

async function conflictedFiles(cwd: string): Promise<string[]> {
  return (await git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
}

async function filesWithMarkers(cwd: string, files: string[]): Promise<string[]> {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const marked: string[] = [];
  for (const file of files) {
    const content = await readFile(path.join(root, file), 'utf8').catch(() => '');
    if (MARKER.test(content)) marked.push(file);
  }
  return marked;
}

async function tryGit(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  // GIT_EDITOR=true: `rebase --continue` must never wait on an editor.
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' },
  });
  return stdout;
}
