import { useEffect, useState, type ReactNode } from 'react';
import { PanelLeftClose, PanelLeftOpen, Settings, SquarePen } from 'lucide-react';
import { fetchSessions, deleteSession } from '../lib/client.ts';
import { ModeSwitcher } from './ModeSwitcher.tsx';
import { SessionList } from './SessionList.tsx';
import { ThemeLogo } from './ThemeLogo.tsx';
import type { SessionMeta, WorkspaceMode } from '../types.ts';

const NEW_CHAT_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘N' : 'Ctrl+N';

type Props = {
  currentSessionId?: string;
  runningSessionId?: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onOpenSettings: () => void;
  refreshKey?: number;
  mode: WorkspaceMode;
  onModeChange: (m: WorkspaceMode) => void;
};

function RailButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className="p-2 rounded-lg text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors"
    >
      {children}
    </button>
  );
}

export function Sidebar({
  currentSessionId,
  runningSessionId,
  onNewChat,
  onSelectSession,
  onOpenSettings,
  refreshKey,
  mode,
  onModeChange,
}: Props) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fetchSessions().then(setSessions).catch(() => {
      // server not available
    });
  }, [refreshKey, currentSessionId, runningSessionId]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    await deleteSession(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === currentSessionId) onNewChat();
  };

  if (collapsed) {
    return (
      <div className="flex flex-col items-center w-12 h-full bg-surface border-r border-border py-3 gap-1 flex-shrink-0">
        <RailButton title="Expand sidebar" onClick={() => setCollapsed(false)}>
          <PanelLeftOpen size={16} />
        </RailButton>
        <RailButton title={`New chat (${NEW_CHAT_SHORTCUT})`} onClick={onNewChat}>
          <SquarePen size={16} />
        </RailButton>
        <div className="flex-1" />
        <RailButton title="Settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </RailButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-60 h-full bg-surface border-r border-border flex-shrink-0">
      <div className="flex items-center justify-between pl-4 pr-2 py-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <ThemeLogo className="w-6 h-6 rounded-md" />
          <span className="font-semibold text-sm text-fg">DvalinCode</span>
        </div>
        <RailButton title="Collapse sidebar" onClick={() => setCollapsed(true)}>
          <PanelLeftClose size={15} />
        </RailButton>
      </div>

      <div className="px-2 flex flex-col gap-2 flex-shrink-0">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-fg hover:bg-surface-2 transition-colors"
        >
          <SquarePen size={15} className="text-muted-fg" />
          New chat
          <kbd className="ml-auto font-sans text-[11px] text-muted-fg">{NEW_CHAT_SHORTCUT}</kbd>
        </button>
        <ModeSwitcher value={mode} onChange={onModeChange} />
      </div>

      <SessionList
        sessions={sessions}
        currentSessionId={currentSessionId}
        runningSessionId={runningSessionId}
        onSelectSession={onSelectSession}
        onDeleteSession={(e, id) => void handleDelete(e, id)}
      />

      <div className="border-t border-border p-2 flex-shrink-0">
        <button
          onClick={onOpenSettings}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-sm text-muted-fg hover:text-fg hover:bg-surface-2 transition-colors"
        >
          <Settings size={15} />
          Settings
        </button>
      </div>
    </div>
  );
}
