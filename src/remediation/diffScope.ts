import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The set of lines a scan should report on.
 *
 * A path present in `files` but absent from `lines` is in scope in full — that
 * is how a newly added or untracked file is represented, since every line of it
 * is new.
 */
export type DiffScope = {
  /** What was compared, for reporting. */
  ref: string;
  /** Workspace-relative POSIX paths. */
  files: Set<string>;
  /** Changed line numbers on the new side, per path. */
  lines: Map<string, Set<number>>;
};

export type DiffScopeOptions = {
  /** A git revision or range. Defaults to uncommitted work against HEAD. */
  ref?: string;
  /** Compare the index instead of the working tree. */
  staged?: boolean;
};

/**
 * Refs reach `git` as a single argv element, so there is no shell to inject
 * into — but a leading dash would still be read as a flag, and git's own ref
 * grammar is narrower than "any string".
 */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:-]*$/;

/** `@@ -old,count +new,count @@` — the new-side pair is what a scan reports on. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function assertSafeRef(ref: string): void {
  if (!SAFE_REF.test(ref)) {
    throw new Error(`Refusing to use '${ref}' as a git revision: expected a ref name or range.`);
  }
}

/**
 * Resolve which files and lines changed, so a scan can report on new work
 * without drowning it in a repository's pre-existing findings.
 */
export async function resolveDiffScope(root: string, options: DiffScopeOptions = {}): Promise<DiffScope> {
  const args = ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--diff-filter=d'];
  let ref: string;

  if (options.staged) {
    args.push('--cached');
    ref = 'staged';
  } else if (options.ref) {
    assertSafeRef(options.ref);
    args.push(options.ref);
    ref = options.ref;
  } else {
    args.push('HEAD');
    ref = 'HEAD';
  }

  const files = new Set<string>();
  const lines = new Map<string, Set<number>>();
  parseUnifiedDiff(await git(root, args), files, lines);

  // An agent's new files are untracked, and `git diff` cannot see them. They
  // are in scope whole — every line is new.
  if (!options.staged && !options.ref) {
    for (const file of await git(root, ['ls-files', '--others', '--exclude-standard']).then(splitLines)) {
      files.add(file);
    }
  }

  return { ref, files, lines };
}

/** Whether a finding at this path and line falls inside the scope. */
export function isWithinDiffScope(scope: DiffScope, filePath: string, startLine: number | undefined): boolean {
  if (!scope.files.has(filePath)) return false;
  const changed = scope.lines.get(filePath);
  // No line detail means the whole file is in scope.
  if (changed === undefined) return true;
  // A finding without a line cannot be placed, so keep it rather than lose it.
  return startLine === undefined || changed.has(startLine);
}

function parseUnifiedDiff(diff: string, files: Set<string>, lines: Map<string, Set<number>>): void {
  let current: string | undefined;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? undefined : stripDiffPrefix(target);
      if (current) files.add(current);
      continue;
    }

    if (!current) continue;

    const hunk = HUNK_HEADER.exec(line);
    if (!hunk) continue;

    const start = Number(hunk[1]);
    // An absent count means one line; an explicit zero means the hunk only
    // removed lines, and there is nothing on the new side to scan.
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count === 0) continue;

    let changed = lines.get(current);
    if (!changed) {
      changed = new Set<number>();
      lines.set(current, changed);
    }
    for (let offset = 0; offset < count; offset += 1) changed.add(start + offset);
  }
}

/** `+++ b/src/app.ts` → `src/app.ts`. Quoted paths keep git's own escaping. */
function stripDiffPrefix(target: string): string {
  return target.replace(/^[abciow]\//, '');
}

function splitLines(output: string): string[] {
  return output.split('\n').map(line => line.trim()).filter(Boolean);
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}
