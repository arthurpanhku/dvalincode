import { useMemo, useState } from 'react';
import { ChevronRight, Download, Loader2, Trash2 } from 'lucide-react';
import { downloadSessionMarkdown } from '../lib/client.ts';
import type { SessionMeta } from '../types.ts';

type Props = {
  sessions: SessionMeta[];
  currentSessionId?: string;
  runningSessionId?: string;
  onSelectSession: (id: string) => void;
  onDeleteSession: (event: React.MouseEvent, id: string) => void;
};

type ProjectGroup = { cwd: string; name: string; sessions: SessionMeta[]; updatedAt: string };

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** Recent conversations, grouped by project folder, newest first. */
export function SessionList({ sessions, currentSessionId, runningSessionId, onSelectSession, onDeleteSession }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const groups = useMemo(() => {
    const byProject = new Map<string, ProjectGroup>();
    for (const session of sessions) {
      // A session that never got a message has nothing to go back to.
      if (session.messageCount === 0 && session.id !== currentSessionId && session.id !== runningSessionId) continue;
      const group = byProject.get(session.cwd);
      if (group) {
        group.sessions.push(session);
        if (session.updatedAt > group.updatedAt) group.updatedAt = session.updatedAt;
      } else {
        byProject.set(session.cwd, { cwd: session.cwd, name: projectName(session.cwd), sessions: [session], updatedAt: session.updatedAt });
      }
    }
    return [...byProject.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [sessions, currentSessionId, runningSessionId]);

  const toggle = (cwd: string) => setCollapsed((previous) => {
    const next = new Set(previous);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    return next;
  });

  return (
    <nav aria-label="Recent conversations" className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
      <div className="px-2 pt-3 pb-1 text-[11px] font-medium text-muted-fg">Recents</div>
      {groups.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-fg">No conversations yet</p>
      ) : groups.map((group) => {
        const open = !collapsed.has(group.cwd);
        return (
          <div key={group.cwd} className="mb-1">
            <button
              onClick={() => toggle(group.cwd)}
              title={group.cwd}
              aria-expanded={open}
              className="w-full flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors"
            >
              <ChevronRight size={12} className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
              <span className="flex-1 truncate text-left">{group.name}</span>
            </button>
            {open && group.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                active={session.id === currentSessionId}
                running={session.id === runningSessionId}
                onSelect={() => onSelectSession(session.id)}
                onDelete={(event) => onDeleteSession(event, session.id)}
              />
            ))}
          </div>
        );
      })}
    </nav>
  );
}

function SessionRow({
  session,
  active,
  running,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  running: boolean;
  onSelect: () => void;
  onDelete: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => event.key === 'Enter' && onSelect()}
      aria-current={active ? 'true' : undefined}
      className={`group flex items-center gap-2 ml-3.5 pl-2.5 pr-1.5 py-1.5 rounded-md cursor-pointer text-xs transition-colors ${
        active ? 'bg-surface-2 text-fg' : 'text-muted-fg hover:text-fg hover:bg-surface-2'
      }`}
    >
      {running && <Loader2 size={11} className="flex-shrink-0 animate-spin text-accent" aria-label="Running" />}
      <span className="flex-1 truncate" title={session.title}>{session.title ?? 'Untitled'}</span>
      {/* The age gives way to the row's actions on hover or keyboard focus. */}
      <span className="flex-shrink-0 text-[10px] text-muted-fg group-hover:hidden group-focus-within:hidden">
        {running ? 'Running' : timeAgo(session.updatedAt)}
      </span>
      <span className="hidden group-hover:flex group-focus-within:flex items-center gap-0.5 flex-shrink-0">
        <button
          onClick={(event) => { event.stopPropagation(); downloadSessionMarkdown(session.id); }}
          title="Download transcript"
          className="p-0.5 rounded hover:text-fg"
        >
          <Download size={11} />
        </button>
        <button onClick={onDelete} title="Delete conversation" className="p-0.5 rounded hover:text-danger-fg">
          <Trash2 size={11} />
        </button>
      </span>
    </div>
  );
}
