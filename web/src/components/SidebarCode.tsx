import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Download, FolderOpen, Loader2, MessageSquare, Plus, Trash2 } from 'lucide-react';
import { downloadSessionMarkdown } from '../lib/client.ts';
import type { SessionMeta } from '../types.ts';

type Props = {
  sessions: SessionMeta[];
  currentSessionId?: string;
  runningSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (event: React.MouseEvent, id: string) => void;
};

type ProjectGroup = { cwd: string; name: string; sessions: SessionMeta[]; updatedAt: string };

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

export function SidebarCode({
  sessions,
  currentSessionId,
  runningSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}: Props) {
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => Object.values(sessions.reduce<Record<string, ProjectGroup>>((acc, session) => {
    const existing = acc[session.cwd];
    if (existing) {
      existing.sessions.push(session);
      if (session.updatedAt > existing.updatedAt) existing.updatedAt = session.updatedAt;
    } else {
      acc[session.cwd] = {
        cwd: session.cwd,
        name: projectName(session.cwd),
        sessions: [session],
        updatedAt: session.updatedAt,
      };
    }
    return acc;
  }, {})).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [sessions]);

  useEffect(() => {
    const active = sessions.find(session => session.id === currentSessionId)?.cwd ?? groups[0]?.cwd;
    if (!active) return;
    setExpandedProjects(previous => previous.has(active) ? previous : new Set([...previous, active]));
  }, [currentSessionId, groups, sessions]);

  const toggleProject = (cwd: string) => setExpandedProjects(previous => {
    const next = new Set(previous);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    return next;
  });

  return (
    <>
      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-orange-500/40 hover:bg-orange-500/5 text-muted-fg hover:text-fg transition-all text-xs"
        >
          <Plus size={13} />
          New coding session
          <kbd className="ml-auto text-[10px] opacity-40">⌘N</kbd>
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border text-[10px] leading-relaxed text-muted-fg/65">
        Code is now focused on autonomous implementation. Security automation lives in <span className="text-emerald-300">Dvalin</span>.
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider px-2 py-1.5">Projects & sessions</div>
        {groups.length === 0 ? (
          <p className="text-xs text-muted-fg/50 px-3 py-4 text-center">No coding sessions yet</p>
        ) : groups.map(group => (
          <div key={group.cwd} className="mb-0.5">
            <button
              onClick={() => toggleProject(group.cwd)}
              title={group.cwd}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2"
            >
              <FolderOpen size={12} className="text-orange-400/75" />
              <span className="flex-1 truncate text-left font-medium">{group.name}</span>
              <span className="text-[10px] opacity-50">{group.sessions.length}</span>
              <ChevronRight size={11} className={`opacity-40 transition-transform ${expandedProjects.has(group.cwd) ? 'rotate-90' : ''}`} />
            </button>
            {expandedProjects.has(group.cwd) && (
              <div className="ml-2 flex flex-col gap-0.5">
                {group.sessions.map(session => (
                  <div
                    key={session.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectSession(session.id)}
                    onKeyDown={event => event.key === 'Enter' && onSelectSession(session.id)}
                    className={`group flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer text-xs border transition-colors ${
                      session.id === currentSessionId
                        ? 'bg-orange-500/10 border-orange-500/20 text-fg'
                        : 'border-transparent text-muted-fg hover:text-fg hover:bg-surface-2'
                    }`}
                  >
                    {session.id === runningSessionId
                      ? <Loader2 size={12} className="mt-0.5 animate-spin text-orange-400" />
                      : <MessageSquare size={12} className="mt-0.5 opacity-50" />}
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{session.summary?.replace(/^User wanted: /, '') ?? group.name}</div>
                      <div className="mt-0.5 text-[10px] opacity-60">{session.id === runningSessionId ? 'Running…' : timeAgo(session.updatedAt)}</div>
                    </div>
                    <button
                      onClick={event => { event.stopPropagation(); downloadSessionMarkdown(session.id); }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-accent"
                      title="Download transcript"
                    >
                      <Download size={11} />
                    </button>
                    <button
                      onClick={event => onDeleteSession(event, session.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400"
                      title="Delete session"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
