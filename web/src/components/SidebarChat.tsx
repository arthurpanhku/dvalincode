import { useState } from 'react';
import { Plus, MessageSquare, Trash2, ChevronRight, BookOpen, Search, GitPullRequest, FlaskConical, Sparkles, Download } from 'lucide-react';
import { downloadSessionMarkdown } from '../lib/client.ts';
import type { SessionMeta } from '../types.ts';

// ── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES = [
  {
    icon: <BookOpen size={12} />,
    label: 'Explain codebase',
    prompt:
      'Give me a high-level overview of this codebase: what it does, how it is structured, and what the main entry points are.',
  },
  {
    icon: <Search size={12} />,
    label: 'Find TODOs',
    prompt:
      'Search the codebase for all TODO, FIXME, HACK, and XXX comments. List them with file paths and line numbers.',
  },
  {
    icon: <GitPullRequest size={12} />,
    label: 'Review changes',
    prompt:
      'Review the recent changes in this project. Check for potential bugs, code quality issues, and suggest improvements.',
  },
  {
    icon: <FlaskConical size={12} />,
    label: 'Write tests',
    prompt:
      'Look at the existing test files and help me write comprehensive tests for the untested parts of the codebase.',
  },
  {
    icon: <Sparkles size={12} />,
    label: 'Refactor suggestion',
    prompt:
      'Analyse the codebase and suggest the three most impactful refactoring opportunities — with clear rationale for each.',
  },
];

// ── Session row ───────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SessionRow({
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
          ? 'bg-blue-500/10 border-blue-500/20 text-fg'
          : 'hover:bg-surface-2 text-muted-fg hover:text-fg border-transparent'
      }`}
    >
      <MessageSquare size={12} className="mt-0.5 flex-shrink-0 opacity-50" />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate leading-tight">
          {session.summary
            ? session.summary.replace(/^User wanted: /, '').slice(0, 38)
            : session.cwd.split('/').pop() ?? session.id}
        </div>
        <div className="text-[10px] text-muted-fg mt-0.5 opacity-70">
          {timeAgo(session.updatedAt)} · {session.messageCount} msg
        </div>
      </div>
      <button
        onClick={(e) => { e.stopPropagation(); downloadSessionMarkdown(session.id); }}
        title="Download Markdown transcript"
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-accent transition-all flex-shrink-0"
      >
        <Download size={11} />
      </button>
      <button
        onClick={onDelete}
        className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-red-400 transition-all flex-shrink-0"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

type Props = {
  sessions: SessionMeta[];
  currentSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
  onSend: (text: string) => void;
};

export function SidebarChat({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onSend,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      {/* New chat */}
      <div className="px-3 py-2">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-border hover:border-blue-500/40 hover:bg-blue-500/5 text-muted-fg hover:text-fg transition-all text-xs"
        >
          <Plus size={13} />
          New chat
          <kbd className="ml-auto text-[10px] opacity-40">⌘N</kbd>
        </button>
      </div>

      {/* Templates */}
      <div className="px-3 pb-2 border-b border-border">
        <div className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider px-1 mb-1">
          Templates
        </div>
        {TEMPLATES.slice(0, expanded ? TEMPLATES.length : 3).map((t) => (
          <button
            key={t.label}
            onClick={() => onSend(t.prompt)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors text-left"
          >
            <span className="text-blue-400/70 flex-shrink-0">{t.icon}</span>
            <span className="flex-1 truncate">{t.label}</span>
            <ChevronRight size={10} className="opacity-30 flex-shrink-0" />
          </button>
        ))}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-[11px] text-muted-fg/50 hover:text-muted-fg py-1 transition-colors"
        >
          {expanded ? '▲ less' : `+${TEMPLATES.length - 3} more`}
        </button>
      </div>

      {/* History */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider px-2 py-1.5">
          History
        </div>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted-fg/50 px-3 py-3 text-center">No conversations yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map((s) => (
              <SessionRow
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
    </>
  );
}
