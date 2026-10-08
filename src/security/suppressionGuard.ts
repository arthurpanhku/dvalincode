import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Suppressions a change adds are not honored when judging that change.
 *
 * The cheapest way to make a scanner stop reporting a finding is to tell it to
 * stop: an entry in `.snyk`, a `// deepcode ignore` above the line, a
 * `nosemgrep` at the end of it. A fix loop that runs "until the scanner is
 * clean" rewards exactly that, and an agent under that pressure will find it.
 * A suppression is a decision a person makes about risk; it is never a repair.
 *
 * So when a change is judged, the head is scanned as though the suppressions
 * the change itself introduced did not exist: ignore files are restored to the
 * base commit's version, and inline markers on lines the change added are
 * blanked in place (same length, so every line and column stays put). A target
 * the change merely silenced is still found, and fails as `target-remains`; a
 * finding the change introduced and then silenced is still found, and fails as
 * `regressed`. Suppressions that already existed on base are base policy and
 * stay in force.
 */

/** Files whose content tells a scanner what not to report. Matched by basename anywhere in the tree. */
export const SUPPRESSION_FILES = [
  '.snyk',
  '.semgrepignore',
  '.trivyignore',
  '.trivyignore.yaml',
  'trivy.yaml',
  'osv-scanner.toml',
  '.gitleaksignore',
  '.dvalincodeignore',
  'dvalin.security.json',
] as const;

/** Inline markers that silence a finding on or near their line, and the engine that reads them. */
export const INLINE_SUPPRESSION_MARKERS: ReadonlyArray<{ engine: string; pattern: RegExp }> = [
  // Snyk Code: `// deepcode ignore <rule>: reason` and `// file deepcode ignore ...`.
  { engine: 'snyk-code', pattern: /\bdeepcode\s+ignore\b/gi },
  { engine: 'semgrep', pattern: /\bnosemgrep\b/gi },
  { engine: 'trivy', pattern: /\btrivy:ignore\b/gi },
  // gosec and bandit.
  { engine: 'gosec/bandit', pattern: /\bnosec\b/gi },
  { engine: 'sonar', pattern: /\bNOSONAR\b/g },
  { engine: 'codeql', pattern: /\b(?:lgtm|codeql)\[/gi },
];

export type SuppressionChange =
  | { kind: 'ignore-file'; path: string; change: 'added' | 'modified' | 'deleted' }
  | { kind: 'inline'; path: string; line: number; engine: string; marker: string };

export type NeutralizedTree = {
  /** A copy of the workspace with the change's own suppressions removed. */
  root: string;
  cleanup: () => Promise<void>;
};

/**
 * Suppressions this workspace adds relative to `baseCommit`, including
 * uncommitted and untracked work. Paths are relative to `root`.
 */
export async function detectSuppressionChanges(root: string, baseCommit: string): Promise<SuppressionChange[]> {
  const changes: SuppressionChange[] = [];
  const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();

  // Ignore files: any change counts, because adding a line and widening a
  // glob are the same act.
  const status = await git(root, ['diff', '--name-status', '--no-renames', '--relative', baseCommit, '--', '.']);
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, file] = line.split('\t');
    if (!code || !file || !isSuppressionFile(file)) continue;
    changes.push({ kind: 'ignore-file', path: toPosix(file), change: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified' });
  }
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean);
  for (const file of untracked) {
    if (isSuppressionFile(file)) changes.push({ kind: 'ignore-file', path: toPosix(file), change: 'added' });
  }

  // Inline markers on added lines. A marker on a line that also exists,
  // verbatim, in the base version of the file was moved or re-indented, not
  // added — blanking it would turn a base suppression into a false regression.
  const added = parseAddedLines(await git(root, ['diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', baseCommit, '--', '.']));
  for (const file of untracked) {
    if (isSuppressionFile(file)) continue;
    const content = await readFile(path.join(root, file), 'utf8').catch(() => '');
    added.set(toPosix(file), content.split('\n').map((text, index) => ({ line: index + 1, text })));
  }
  for (const [file, lines] of added) {
    if (isSuppressionFile(file)) continue;
    const baseLines = await baseContent(root, baseCommit, prefix, file)
      .then(content => new Set(content.split('\n').map(text => text.trim())))
      .catch(() => new Set<string>());
    for (const { line, text } of lines) {
      if (baseLines.has(text.trim())) continue;
      for (const marker of INLINE_SUPPRESSION_MARKERS) {
        const match = new RegExp(marker.pattern.source, marker.pattern.flags).exec(text);
        if (match) changes.push({ kind: 'inline', path: file, line, engine: marker.engine, marker: match[0] });
      }
    }
  }
  return changes;
}

/**
 * Copy the workspace with the given suppression changes undone.
 *
 * Copies tracked and untracked-but-not-ignored files, so what is scanned is
 * what a commit of this working tree would contain. Only call this when
 * `changes` is non-empty; otherwise scan the workspace itself.
 */
export async function neutralizeSuppressions(
  root: string,
  baseCommit: string,
  changes: SuppressionChange[],
): Promise<NeutralizedTree> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'dvalin-neutralized-'));
  const copy = path.join(scratch, 'tree');
  const cleanup = () => rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  try {
    const prefix = (await git(root, ['rev-parse', '--show-prefix'])).trim();
    const files = (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean);
    for (const file of files) {
      const target = path.join(copy, file);
      await mkdir(path.dirname(target), { recursive: true });
      // A tracked file deleted in the working tree is simply absent here.
      await copyFile(path.join(root, file), target).catch(() => undefined);
    }

    for (const change of changes) {
      if (change.kind !== 'ignore-file') continue;
      const target = path.join(copy, change.path);
      const original = await baseContent(root, baseCommit, prefix, change.path).catch(() => undefined);
      if (original === undefined) await rm(target, { force: true });
      else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, original, 'utf8');
      }
    }

    const inline = new Map<string, Array<Extract<SuppressionChange, { kind: 'inline' }>>>();
    for (const change of changes) {
      if (change.kind === 'inline') inline.set(change.path, [...(inline.get(change.path) ?? []), change]);
    }
    for (const [file, markers] of inline) {
      const target = path.join(copy, file);
      const lines = (await readFile(target, 'utf8')).split('\n');
      for (const { line } of markers) {
        const index = line - 1;
        if (lines[index] === undefined) continue;
        lines[index] = blankMarkers(lines[index]!);
      }
      await writeFile(target, lines.join('\n'), 'utf8');
    }
    return { root: copy, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Replace every suppression marker on a line with spaces of the same length. */
export function blankMarkers(line: string): string {
  let result = line;
  for (const marker of INLINE_SUPPRESSION_MARKERS) {
    result = result.replace(new RegExp(marker.pattern.source, marker.pattern.flags), match => ' '.repeat(match.length));
  }
  return result;
}

export function isSuppressionFile(file: string): boolean {
  return (SUPPRESSION_FILES as readonly string[]).includes(path.posix.basename(toPosix(file)));
}

export function describeSuppressionChange(change: SuppressionChange): string {
  return change.kind === 'ignore-file'
    ? `${change.path} ${change.change} (scanner ignore policy)`
    : `${change.path}:${change.line} adds \`${change.marker}\` (${change.engine})`;
}

/** New-side line numbers and text for every `+` line of a zero-context diff. */
function parseAddedLines(diff: string): Map<string, Array<{ line: number; text: string }>> {
  const added = new Map<string, Array<{ line: number; text: string }>>();
  let file: string | undefined;
  let next = 0;
  // File headers only between `diff --git` and the first hunk; inside a hunk
  // an added line that itself starts with `++` must not read as a header.
  let inHeader = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      inHeader = true;
      file = undefined;
      continue;
    }
    if (inHeader) {
      if (raw.startsWith('+++ ')) {
        const name = raw.slice(4).trim();
        file = name === '/dev/null' ? undefined : name.replace(/^b\//, '');
        continue;
      }
      if (!raw.startsWith('@@')) continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      inHeader = false;
      next = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      added.set(file, [...(added.get(file) ?? []), { line: next, text: raw.slice(1) }]);
      next += 1;
    }
  }
  return added;
}

async function baseContent(root: string, baseCommit: string, prefix: string, file: string): Promise<string> {
  return git(root, ['show', `${baseCommit}:${prefix}${toPosix(file)}`]);
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
