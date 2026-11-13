import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { isIgnoredPath } from './ignorefile.js';
import { resolveInsideWorkspace, resolveWorkspaceRoot } from './workspace.js';

const execFileAsync = promisify(execFile);

/**
 * Config overrides for read-only git commands run on the agent's behalf. A
 * workspace is untrusted input, and its own git config can name programs that
 * git runs while reading: an fsmonitor hook, a signature checker
 * (gpg.program, reached through log.showSignature), and external diff or
 * textconv drivers. These overrides, plus the --no-ext-diff / --no-textconv /
 * --no-show-signature flags the callers pass, keep reading history from
 * running anything the repository configured.
 */
const SAFE_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '-c', 'core.quotePath=false',
  '-c', 'color.ui=false',
];

const MAX_BUFFER = 8 * 1024 * 1024;

export type GitReadResult = { stdout: string; truncated: boolean };

/** Run one read-only git command, keeping at most `maxBytes` of its output. */
export async function gitRead(args: string[], cwd: string, maxBytes: number): Promise<GitReadResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
  delete env.GIT_EXTERNAL_DIFF;

  let stdout: string;
  let truncated = false;
  try {
    ({ stdout } = await execFileAsync('git', [...SAFE_CONFIG, ...args], {
      cwd,
      env,
      maxBuffer: MAX_BUFFER,
      timeout: 30_000,
      windowsHide: true,
    }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof err.stdout === 'string') {
      stdout = err.stdout;
      truncated = true;
    } else if (err.code === 'ENOENT') {
      throw new Error('git is not installed or not on PATH');
    } else {
      const detail = err.stderr?.trim().split('\n').find(Boolean);
      throw new Error(detail ?? err.message);
    }
  }

  if (Buffer.byteLength(stdout, 'utf8') > maxBytes) {
    stdout = Buffer.from(stdout, 'utf8').subarray(0, maxBytes).toString('utf8');
    truncated = true;
  }
  return { stdout, truncated };
}

/**
 * A revision the model asked for. Leading dashes (which git would read as an
 * option, such as --output=<file>), whitespace, and the rev:path form (which
 * would print a file's contents past the ignore rules) are refused.
 */
export function assertRevision(ref: string): string {
  if (!/^[^\s:\\-][^\s:\\]*$/.test(ref)) {
    throw new Error(`Not a usable revision: "${ref}". Use a branch, tag, commit, or range such as main..HEAD.`);
  }
  return ref;
}

/** Pathspecs that keep .dvalincodeignore'd paths out of git output, matching read_file's rules. */
export function excludePathspecs(patterns: string[]): string[] {
  return patterns.flatMap(raw => {
    const pattern = raw.replace(/^\/+|\/+$/g, '');
    if (!pattern || pattern.startsWith('!')) return [];
    return [
      `:(exclude,glob)${pattern}`,
      `:(exclude,glob)**/${pattern}`,
      `:(exclude,glob)${pattern}/**`,
      `:(exclude,glob)**/${pattern}/**`,
    ];
  });
}

/**
 * A workspace path as git expects it: relative to the workspace and with
 * forward slashes. The path may no longer exist (history of a deleted file).
 * Paths outside the workspace or excluded by .dvalincodeignore are refused.
 */
export async function workspaceGitPath(cwd: string, filePath: string, ignorePatterns: string[]): Promise<string> {
  const resolved = await resolveInsideWorkspace(cwd, filePath);
  // Relative to the real root, not cwd: cwd may be a symlink (macOS /tmp).
  const relative = path.relative(await resolveWorkspaceRoot(cwd), resolved).split(path.sep).join('/') || '.';
  if (relative !== '.' && isIgnoredPath(relative, ignorePatterns)) {
    throw new Error(`Path excluded by .dvalincodeignore: ${filePath}`);
  }
  return relative;
}
