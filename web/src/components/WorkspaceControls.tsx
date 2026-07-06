import { useState, useRef, useEffect } from 'react';
import { FolderOpen, GitBranch, GitPullRequest, Loader2, ChevronDown, FolderGit2 } from 'lucide-react';
import { cloneGitProject, createGitWorktree, openProjectFolder } from '../lib/client.ts';

type Props = {
  cwd?: string;
  onCwdChange: (cwd: string) => void;
};

type WorkspaceAction = 'menu' | 'clone' | 'worktree';

export function WorkspaceControls({ cwd, onCwdChange }: Props) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<WorkspaceAction>('menu');
  const ref = useRef<HTMLDivElement>(null);

  const [gitUrl, setGitUrl] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [branch, setBranch] = useState('');
  const [worktreePath, setWorktreePath] = useState('');
  const [createBranch, setCreateBranch] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const run = async (label: string, action: () => Promise<{ cwd: string }>) => {
    setBusy(label);
    setError('');
    try {
      const result = await action();
      onCwdChange(result.cwd);
      setOpen(false);
      setAction('menu');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const folderName = cwd ? cwd.split(/[\\/]/).pop() : undefined;
  const defaultWorktreePath = cwd && branch.trim()
    ? `${cwd}-${branch.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')}`
    : '';

  const inputClass = 'w-full bg-elevated border border-border rounded-lg px-2.5 py-2 text-xs text-fg placeholder-muted-fg outline-none focus:border-accent/40';
  const buttonClass = 'w-full flex items-center justify-center gap-1.5 py-2 text-xs rounded-lg border transition-colors disabled:opacity-45 bg-accent/10 hover:bg-accent/15 border-accent/25 text-accent';
  const actionClass = 'w-full flex items-center gap-2.5 px-3 py-2.5 text-left rounded-lg border border-border bg-elevated text-fg hover:bg-surface-2 hover:border-accent/30 transition-colors disabled:opacity-45 disabled:hover:bg-elevated disabled:hover:border-border';

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => {
          setOpen((v) => !v);
          setAction('menu');
        }}
        title={cwd ?? 'Set workspace'}
        className="flex items-center gap-1.5 text-[11px] text-muted-fg hover:text-fg transition-colors group"
      >
        <FolderGit2 size={12} className="opacity-60 flex-shrink-0" />
        <span className="truncate max-w-[120px]">{folderName ?? 'Workspace'}</span>
        <ChevronDown size={10} className="opacity-40 group-hover:opacity-80 transition-opacity flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-72 bg-surface border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border flex items-center justify-between text-[11px] text-muted-fg">
            {action === 'menu' ? (
              <span>Project</span>
            ) : (
              <button
                onClick={() => { setAction('menu'); setError(''); }}
                className="hover:text-fg transition-colors"
              >
                ← Project
              </button>
            )}
            {folderName && <span className="truncate max-w-[120px] opacity-60">{folderName}</span>}
          </div>

          <div className="p-3 flex flex-col gap-2">
            {action === 'menu' && (
              <>
                <button
                  onClick={() => void run('open', () => openProjectFolder())}
                  disabled={busy !== null}
                  className={actionClass}
                  title="Open local folder"
                >
                  {busy === 'open' ? <Loader2 size={13} className="animate-spin text-accent" /> : <FolderOpen size={13} className="text-accent flex-shrink-0" />}
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">Open folder</span>
                    <span className="block text-[10px] text-muted-fg truncate">Use a local project</span>
                  </span>
                  <ChevronDown size={10} className="-rotate-90 opacity-40" />
                </button>

                <button
                  onClick={() => { setAction('clone'); setError(''); }}
                  disabled={busy !== null}
                  className={actionClass}
                  title="Import Git project"
                >
                  <GitPullRequest size={13} className="text-accent flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">Import Git</span>
                    <span className="block text-[10px] text-muted-fg truncate">Clone into DvalinCode projects</span>
                  </span>
                  <ChevronDown size={10} className="-rotate-90 opacity-40" />
                </button>

                <button
                  onClick={() => { setAction('worktree'); setError(''); }}
                  disabled={busy !== null || !cwd}
                  className={actionClass}
                  title="Create Git worktree"
                >
                  <GitBranch size={13} className="text-accent flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">Add worktree</span>
                    <span className="block text-[10px] text-muted-fg truncate">{cwd ? 'Create from current project' : 'Open a project first'}</span>
                  </span>
                  <ChevronDown size={10} className="-rotate-90 opacity-40" />
                </button>
              </>
            )}

            {action === 'clone' && (
              <>
                <input
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="Git repository URL"
                  className={inputClass}
                />
                <details className="group">
                  <summary className="cursor-pointer list-none text-[11px] text-muted-fg hover:text-fg px-1 py-0.5">
                    Destination folder
                  </summary>
                  <input
                    value={parentDir}
                    onChange={(e) => setParentDir(e.target.value)}
                    placeholder="Default: ~/.dvalincode/projects"
                    className={`${inputClass} mt-1`}
                  />
                </details>
                <button
                  onClick={() => void run('clone', () => cloneGitProject(gitUrl, parentDir || undefined))}
                  disabled={busy !== null || !gitUrl.trim()}
                  className={buttonClass}
                  title="Clone Git project"
                >
                  {busy === 'clone' ? <Loader2 size={11} className="animate-spin" /> : <GitPullRequest size={11} />}
                  Import Git
                </button>
              </>
            )}

            {action === 'worktree' && (
              <>
                <input
                  value={branch}
                  onChange={(e) => {
                    setBranch(e.target.value);
                    if (!worktreePath) {
                      const next = cwd && e.target.value.trim()
                        ? `${cwd}-${e.target.value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-')}`
                        : '';
                      setWorktreePath(next);
                    }
                  }}
                  placeholder="Branch name"
                  className={inputClass}
                />
                <input
                  value={worktreePath}
                  onChange={(e) => setWorktreePath(e.target.value)}
                  placeholder={defaultWorktreePath || 'Worktree path'}
                  className={inputClass}
                />
                <label className="flex items-center gap-2 text-[11px] text-muted-fg bg-elevated border border-border rounded-lg px-2.5 py-2">
                  <input
                    type="checkbox"
                    checked={createBranch}
                    onChange={(e) => setCreateBranch(e.target.checked)}
                    className="accent-current"
                  />
                  Create a new branch
                </label>
                <button
                  onClick={() => void run('worktree', () => createGitWorktree(cwd ?? '', branch, worktreePath, createBranch))}
                  disabled={busy !== null || !cwd || !branch.trim() || !worktreePath.trim()}
                  className={buttonClass}
                  title="Create Git worktree"
                >
                  {busy === 'worktree' ? <Loader2 size={11} className="animate-spin" /> : <GitBranch size={11} />}
                  Add worktree
                </button>
              </>
            )}

            {error && (
              <div className="px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20 text-[10px] text-red-300">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
