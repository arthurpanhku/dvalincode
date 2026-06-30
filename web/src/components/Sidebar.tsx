import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchSessions, deleteSession } from '../lib/client.ts';
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
    </div>
  );
}
