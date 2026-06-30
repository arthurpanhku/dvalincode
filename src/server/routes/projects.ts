import { Router } from 'express';
import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { rateLimit } from 'express-rate-limit';
import {
  allowWorkspaceRoot,
  assertSafeUserPathInput,
  pathIsInside,
  resolveAllowedCwd,
  resolveAllowedNewPath,
} from '../security.js';

const execAsync = promisify(execFile);
export const projectsRouter = Router();
projectsRouter.use(rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}));

function projectsHome(): string {
  return path.join(homedir(), '.dvalincode', 'projects');
}

function safeName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/\.git$/, '')
    .split(/[\\/]/)
    .pop()!
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80);
  const trimmed = trimDashes(cleaned);
  return trimmed || `project-${Date.now()}`;
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

function nameFromGitUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return safeName(parsed.pathname);
  } catch {
    return safeName(url);
  }
}

export function validateGitCloneUrl(value: string): string {
  const url = value.trim();
  if (!url || url.length > 2048 || url.startsWith('-') || /[\0\r\n]/.test(url)) {
    throw new Error('Invalid Git URL');
  }

  try {
    const parsed = new URL(url);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      throw new Error('Unsupported Git URL protocol');
    }
    if (!parsed.hostname) throw new Error('Git URL must include a host');
    return url;
  } catch (err) {
    if (err instanceof Error && err.message === 'Unsupported Git URL protocol') throw err;
  }

  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+(?:\.git)?$/.test(url)) {
    return url;
  }
  throw new Error('Git URL must be http(s), ssh, git, or scp-style');
}

export function validateGitBranchName(value: string): string {
  const branch = value.trim();
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(branch) ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch.endsWith('.lock')
  ) {
    throw new Error('Invalid Git branch name');
  }
  return branch;
}

async function pickFolder(): Promise<string> {
  if (process.platform === 'darwin') {
    const script = 'POSIX path of (choose folder with prompt "Choose a DvalinCode workspace")';
    const { stdout } = await execAsync('osascript', ['-e', script]);
    return stdout.trim();
  }

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Choose a DvalinCode workspace"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath }',
    ].join('; ');
    const { stdout } = await execAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script]);
    return stdout.trim();
  }

  for (const picker of [
    { command: 'zenity', args: ['--file-selection', '--directory', '--title=DvalinCode workspace'] },
    { command: 'kdialog', args: ['--getexistingdirectory', process.cwd(), 'DvalinCode workspace'] },
  ]) {
    try {
      const { stdout } = await execAsync(picker.command, picker.args);
      return stdout.trim();
    } catch {
      // Try the next desktop picker.
    }
  }
  throw new Error('No folder picker is available. Enter the workspace path manually.');
}

projectsRouter.post('/open', async (req, res) => {
  const body = req.body as { cwd?: string };
  try {
    const cwd = body.cwd
      ? await allowWorkspaceRoot(body.cwd)
      : await allowWorkspaceRoot(await pickFolder());
    res.json({ cwd });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not open workspace' });
  }
});

projectsRouter.post('/clone', async (req, res) => {
  const body = req.body as { url?: string; parentDir?: string; name?: string };
  if (!body.url?.trim()) {
    res.status(400).json({ error: 'Missing Git URL' });
    return;
  }

  try {
    const gitUrl = validateGitCloneUrl(body.url);
    const parent = body.parentDir?.trim()
      ? await allowWorkspaceRoot(body.parentDir)
      : await allowWorkspaceRoot(projectsHome());
    await mkdir(parent, { recursive: true });
    const target = path.join(parent, safeName(body.name || nameFromGitUrl(gitUrl)));
    if (!pathIsInside(parent, target)) throw new Error('Clone target escapes parent directory');
    await execAsync('git', ['clone', '--', gitUrl, target], { cwd: parent });
    const cwd = await allowWorkspaceRoot(target);
    res.json({ cwd });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not clone repository' });
  }
});

projectsRouter.post('/worktree', async (req, res) => {
  const body = req.body as { cwd?: string; branch?: string; path?: string; createBranch?: boolean };
  if (!body.cwd || !body.branch?.trim() || !body.path?.trim()) {
    res.status(400).json({ error: 'cwd, branch, and path are required' });
    return;
  }

  try {
    const repo = await resolveAllowedCwd(body.cwd);
    const branch = validateGitBranchName(body.branch);
    const target = await resolveAllowedNewPath(
      assertSafeUserPathInput(body.path, 'worktree path'),
      'worktree path',
    );

    // target is constrained to an allowed workspace root by resolveAllowedNewPath.
    // codeql[js/path-injection]
    await mkdir(path.dirname(target), { recursive: true });
    const args = body.createBranch
      ? ['worktree', 'add', '-b', branch, target]
      : ['worktree', 'add', target, branch];
    await execAsync('git', args, { cwd: repo });

    // target is constrained to an allowed workspace root before git creates it.
    // codeql[js/path-injection]
    const cwd = await allowWorkspaceRoot(await realpath(target));
    res.json({ cwd });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not create worktree' });
  }
});
