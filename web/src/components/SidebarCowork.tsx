import { useState } from 'react';
import {
  Plus, Trash2, FolderOpen, ChevronRight, ClipboardList,
} from 'lucide-react';
import type { SessionMeta } from '../types.ts';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function TaskRow({
  session,
  active,
  onSelect,
  onDelete,
}: {
  session: SessionMeta;
  active: boolean;
  onSelect: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className={`group flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors text-xs border ${
        active
          ? 'bg-violet-500/10 border-violet-500/20 text-fg'
          : 'hover:bg-[#1a1a1a] text-muted-fg hover:text-fg border-transparent'
      }`}
    >
      <ClipboardList size={12} className="mt-0.5 flex-shrink-0 opacity-50" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate leading-tight">
          {session.summary
            ? session.summary.replace(/^User wanted: /, '').slice(0, 38)
            : `Task · ${session.cwd.split('/').pop()}`}
        </div>
        <div className="text-[10px] text-muted-fg mt-0.5 opacity-70">
          {timeAgo(session.updatedAt)} · {session.messageCount} msg
        </div>
      </div>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-red-400 transition-all flex-shrink-0"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

type Props = {
  sessions: SessionMeta[];
  currentSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
};

type Project = { name: string; cwd: string; sessions: SessionMeta[] };

export function SidebarCowork({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}: Props) {
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [view, setView] = useState<'projects' | 'all'>('projects');

  // Group by cwd
  const projectMap = sessions.reduce<Record<string, Project>>((acc, s) => {
    const key = s.cwd;
    const name = key.split('/').filter(Boolean).pop() ?? key;
    if (!acc[key]) acc[key] = { name, cwd: key, sessions: [] };
    acc[key].sessions.push(s);
    return acc;
  }, {});
  const projects = Object.values(projectMap).sort(
    (a, b) =>
      new Date(b.sessions[0]!.updatedAt).getTime() -
      new Date(a.sessions[0]!.updatedAt).getTime(),
  );

  const displayedSessions =
    view === 'all'
      ? sessions
      : activeProject
      ? (projectMap[activeProject]?.sessions ?? [])
      : sessions;

  return (
    <>
      {/* New task */}
      <div className="px-3 py-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-violet-500/40 hover:bg-violet-500/5 text-muted-fg hover:text-fg transition-all text-xs"
        >
          <Plus size={13} />
          New task
          <kbd className="ml-auto text-[10px] opacity-40">⌘N</kbd>
        </button>
      </div>

      {/* View toggle */}
      <div className="px-3 pb-2 flex gap-1">
        {(['projects', 'all'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`flex-1 py-1 text-[11px] rounded-md capitalize transition-colors ${
              view === v
                ? 'bg-violet-500/15 text-violet-300 font-medium'
                : 'text-muted-fg hover:text-fg'
            }`}
          >
            {v === 'projects' ? 'Projects' : 'All tasks'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {view === 'projects' ? (
          /* Projects tree */
          projects.length === 0 ? (
            <p className="text-xs text-muted-fg/50 px-3 py-3 text-center">No tasks yet</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {projects.map((p) => (
                <div key={p.cwd}>
                  {/* Project header */}
                  <button
                    onClick={() =>
                      setActiveProject(activeProject === p.cwd ? null : p.cwd)
                    }
                    className="w-full flex items-center gap-2 px-2 py-2 rounded-lg text-xs hover:bg-[#1a1a1a] text-muted-fg hover:text-fg transition-colors"
                  >
                    <FolderOpen size={12} className="text-violet-400/70 flex-shrink-0" />
                    <span className="flex-1 font-medium truncate text-left">{p.name}</span>
                    <span className="text-[10px] opacity-50 flex-shrink-0">
                      {p.sessions.length}
                    </span>
                    <ChevronRight
                      size={11}
                      className={`opacity-40 flex-shrink-0 transition-transform ${
                        activeProject === p.cwd ? 'rotate-90' : ''
                      }`}
                    />
                  </button>
                  {/* Project sessions */}
                  {activeProject === p.cwd && (
                    <div className="ml-2 flex flex-col gap-0.5">
                      {p.sessions.map((s) => (
                        <TaskRow
                          key={s.id}
                          session={s}
                          active={s.id === currentSessionId}
                          onSelect={() => onSelectSession(s.id)}
                          onDelete={(e) => onDeleteSession(e, s.id)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          /* All tasks flat list */
          <>
            <div className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider px-2 py-1.5">
              All tasks
            </div>
            {displayedSessions.length === 0 ? (
              <p className="text-xs text-muted-fg/50 px-3 py-3 text-center">No tasks yet</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {displayedSessions.map((s) => (
                  <TaskRow
                    key={s.id}
                    session={s}
                    active={s.id === currentSessionId}
                    onSelect={() => onSelectSession(s.id)}
                    onDelete={(e) => onDeleteSession(e, s.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
