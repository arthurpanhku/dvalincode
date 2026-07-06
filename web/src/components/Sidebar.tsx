import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Trash2, X } from 'lucide-react';
import { fetchSessions, deleteSession, deleteAllSessions } from '../lib/client.ts';
import { ModeSwitcher } from './ModeSwitcher.tsx';
import { SidebarChat } from './SidebarChat.tsx';
import { SidebarCowork } from './SidebarCowork.tsx';
import { SidebarCode } from './SidebarCode.tsx';
import { ThemeLogo } from './ThemeLogo.tsx';
import type { SessionMeta, AgentMode } from '../types.ts';

type Props = {
  currentSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onSend: (text: string) => void;
  refreshKey?: number;
  mode: AgentMode;
  onModeChange: (m: AgentMode) => void;
  cwd?: string;
  onCwdChange?: (cwd: string) => void;
};

export function Sidebar({
  currentSessionId,
  onNewChat,
  onSelectSession,
  onSend,
  refreshKey,
  mode,
  onModeChange,
  cwd,
  onCwdChange,
}: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = async () => {
    try {
      setSessions(await fetchSessions());
    } catch {
      // server not available
    }
  };

  useEffect(() => {
    void load();
  }, [refreshKey, currentSessionId]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === currentSessionId) onNewChat();
  };

  const handleClearAll = async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    setClearing(true);
    try {
      await deleteAllSessions();
      setSessions([]);
      setClearConfirm(false);
      onNewChat();
    } finally {
      setClearing(false);
    }
  };

  /* ── Collapsed state ─────────────────────────────────────────── */
  if (collapsed) {
    return (
      <div className="flex flex-col items-center w-12 h-full bg-surface border-r border-border py-3 gap-3 flex-shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg hover:bg-surface-2 text-muted-fg hover:text-fg transition-colors"
          title="Expand sidebar"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    );
  }

  /* ── Expanded state ──────────────────────────────────────────── */
  return (
    <div className="flex flex-col w-60 h-full bg-surface border-r border-border flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <ThemeLogo className="w-6 h-6 rounded-md" />
          <span className="font-semibold text-sm text-fg">DvalinCode</span>
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded hover:bg-surface-2 text-muted-fg hover:text-fg transition-colors"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* Mode switcher — full width */}
      <div className="px-3 py-2 border-b border-border flex-shrink-0">
        <ModeSwitcher value={mode} onChange={onModeChange} fullWidth />
      </div>

      {/* Mode-specific content — fills remaining height */}
      <div className="flex flex-col flex-1 min-h-0">
        {mode === 'chat' && (
          <SidebarChat
            sessions={sessions}
            currentSessionId={currentSessionId}
            onNewChat={onNewChat}
            onSelectSession={onSelectSession}
            onDeleteSession={handleDelete}
            onSend={onSend}
          />
        )}
        {mode === 'cowork' && (
          <SidebarCowork
            sessions={sessions}
            currentSessionId={currentSessionId}
            onNewChat={onNewChat}
            onSelectSession={onSelectSession}
            onDeleteSession={handleDelete}
          />
        )}
        {mode === 'code' && (
          <SidebarCode
            sessions={sessions}
            currentSessionId={currentSessionId}
            onNewChat={onNewChat}
            onSelectSession={onSelectSession}
            onDeleteSession={handleDelete}
            onSend={onSend}
            cwd={cwd}
            onCwdChange={onCwdChange}
          />
        )}
      </div>

      {sessions.length > 0 && (
        <div className="border-t border-border px-3 py-2 flex-shrink-0">
          {clearConfirm ? (
            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-2 py-2">
              <div className="flex items-start gap-1.5 text-[11px] text-red-300">
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span className="flex-1">Clear all {sessions.length} sessions?</span>
              </div>
              <div className="mt-2 flex gap-1.5">
                <button
                  onClick={() => setClearConfirm(false)}
                  disabled={clearing}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] rounded-md border border-border text-muted-fg hover:text-fg hover:bg-surface-2 disabled:opacity-50"
                >
                  <X size={11} />
                  Cancel
                </button>
                <button
                  onClick={() => void handleClearAll()}
                  disabled={clearing}
                  className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] rounded-md border border-red-500/25 bg-red-500/10 text-red-300 hover:bg-red-500/15 disabled:opacity-50"
                >
                  {clearing ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                  Clear
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => void handleClearAll()}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-border text-muted-fg hover:text-red-300 hover:border-red-500/25 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={12} />
              Clear all sessions
            </button>
          )}
        </div>
      )}
    </div>
  );
}
