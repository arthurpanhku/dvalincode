import { Bug, ChevronRight, GitPullRequest, Loader2, MessageSquare, Plus, Radar, ShieldCheck, Trash2 } from 'lucide-react';
import type { SessionMeta } from '../types.ts';

type Props = {
  sessions: SessionMeta[];
  currentSessionId?: string;
  runningSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (event: React.MouseEvent, id: string) => void;
  onSend: (prompt: string) => void;
};

const ACTIONS = [
  {
    label: 'Attack-surface review',
    Icon: Radar,
    prompt: 'Use the Dvalin security engineer skill to map this repository attack surface, trust boundaries, entry points, and highest-risk data flows. Do not edit yet.',
  },
  {
    label: 'Validate open findings',
    Icon: Bug,
    prompt: 'List the open remediation cases, validate each high-severity finding against the source and reachable data flow, and classify likely true positives versus false positives. Do not suppress findings.',
  },
  {
    label: 'Prepare security PR',
    Icon: GitPullRequest,
    prompt: 'Review the current security remediation diff and verification evidence. If it is ready, produce a draft pull-request title and body, remaining-risk section, and reviewer checklist. Do not push or publish yet.',
  },
];

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function SidebarDvalin({
  sessions,
  currentSessionId,
  runningSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onSend,
}: Props) {
  return (
    <>
      <div className="px-3 py-3 border-b border-border bg-emerald-500/[0.03]">
        <div className="flex items-center gap-2 text-success-fg">
          <ShieldCheck size={15} />
          <div>
            <div className="text-xs font-semibold">Security engineering</div>
            <div className="text-[10px] text-muted-fg mt-0.5">Scan → Fix → Verify → PR</div>
          </div>
        </div>
        <button
          onClick={onNewChat}
          className="mt-3 w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-emerald-500/25 hover:border-emerald-500/45 hover:bg-emerald-500/10 text-success-fg/80 transition-all text-xs"
        >
          <Plus size={13} />
          New security run
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border">
        <div className="text-[10px] font-semibold text-muted-fg uppercase tracking-wider px-1 mb-1">Security actions</div>
        {ACTIONS.map(({ label, Icon, prompt }) => (
          <button
            key={label}
            onClick={() => onSend(prompt)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors text-left"
          >
            <Icon size={11} className="text-success-fg/80 flex-shrink-0" />
            <span className="flex-1 truncate">{label}</span>
            <ChevronRight size={10} className="opacity-30" />
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="text-[10px] font-semibold text-muted-fg uppercase tracking-wider px-2 py-1.5">Security runs</div>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted-fg px-3 py-4 text-center">No security runs yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {sessions.map(session => (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(session.id)}
                onKeyDown={event => event.key === 'Enter' && onSelectSession(session.id)}
                className={`group flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer text-xs border transition-colors ${
                  session.id === currentSessionId
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-fg'
                    : 'border-transparent text-muted-fg hover:text-fg hover:bg-surface-2'
                }`}
              >
                {session.id === runningSessionId
                  ? <Loader2 size={12} className="mt-0.5 animate-spin text-success-fg" />
                  : <MessageSquare size={12} className="mt-0.5 opacity-50" />}
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{session.summary?.replace(/^User wanted: /, '') ?? 'Security run'}</div>
                  <div className="mt-0.5 text-[10px] text-muted-fg">{session.id === runningSessionId ? 'Running…' : timeAgo(session.updatedAt)}</div>
                </div>
                <button
                  onClick={event => onDeleteSession(event, session.id)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-danger-fg"
                  title="Delete run"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
