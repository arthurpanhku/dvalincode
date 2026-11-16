import { useEffect, useState, useCallback, useRef } from 'react';
import { GitBranch, PanelRightOpen, ShieldCheck } from 'lucide-react';
import { Sidebar } from './components/Sidebar.tsx';
import { ChatThread } from './components/ChatThread.tsx';
import { DvalinWorkspace } from './components/DvalinWorkspace.tsx';
import { Composer } from './components/Composer.tsx';
import { SettingsPanel } from './components/SettingsPanel.tsx';
import { LLMConfigModal } from './components/LLMConfigModal.tsx';
import { ApprovalDialog } from './components/ApprovalDialog.tsx';
import { useChat } from './hooks/useChat.ts';
import { fetchSessions, fetchConfig, fetchGitInfo, openProjectFolder, saveConfig } from './lib/client.ts';
import { estimateCost, formatCost } from './lib/pricing.ts';
import { PROVIDERS } from './lib/providers.ts';
import { CODE_MODE_OPTIONS, HOME_MODE_OPTIONS } from './lib/modeOptions.tsx';
import type { ChatImage, AgentMode, ApprovalMode, CodePermissionMode, HomeMode, ProviderKeySource, WorkspaceMode } from './types.ts';

const MODE_APPROVAL: Record<AgentMode, ApprovalMode> = {
  chat:   'readonly',
  cowork: 'auto-edit',
  code:   'full-auto',
  dvalin: 'full-auto',
};

const CODE_APPROVAL: Record<CodePermissionMode, ApprovalMode> = {
  ask: 'auto-edit',
  plan: 'readonly',
  auto: 'full-auto',
  bypass: 'bypass',
};

export default function App() {
  const [sidebarRefresh, setSidebarRefresh] = useState(0);
  const [showLLMConfig, setShowLLMConfig] = useState(false);
  const [activeModel, setActiveModel] = useState('');
  const [llmMeta, setLlmMeta] = useState<{
    apiKeySet: boolean;
    keySource?: ProviderKeySource;
    apiKeyEnv?: string;
  }>({ apiKeySet: false });
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('home');
  const [homeMode, setHomeMode] = useState<HomeMode>('chat');
  const [codePermissionMode, setCodePermissionMode] = useState<CodePermissionMode>('auto');
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [sessionCost, setSessionCost] = useState(0);
  const [dvalinPanelOpen, setDvalinPanelOpen] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<{ cwd: string; provider: string }>({
    cwd: '',
    provider: 'deepseek',
  });
  const mode: AgentMode = workspaceMode === 'home' ? homeMode : workspaceMode;

  const chat = useChat({
    cwd: settings.cwd || undefined,
    approvalMode: mode === 'code' || mode === 'dvalin' ? CODE_APPROVAL[codePermissionMode] : MODE_APPROVAL[mode],
    mode,
    codePermissionMode,
  });

  // Auto-detect cwd from first session; load saved LLM config
  useEffect(() => {
    fetchSessions()
      .then((sessions) => {
        if (sessions[0]?.cwd && !settings.cwd) {
          const cwd = sessions[0].cwd;
          openProjectFolder(cwd)
            .then((project) => {
              setSettings((s) => ({ ...s, cwd: project.cwd }));
              fetchGitInfo(project.cwd).then((g) => setGitBranch(g.branch)).catch(() => {});
            })
            .catch(() => {});
        }
      })
      .catch(() => {});

    fetchConfig()
      .then((cfg) => {
        setActiveModel(cfg.llm.model ?? '');
        setLlmMeta({
          apiKeySet: !!cfg.llm.apiKeySet,
          keySource: cfg.llm.keySource,
          apiKeyEnv: cfg.llm.apiKeyEnv,
        });
        setSettings((s) => ({ ...s, provider: cfg.llm.provider }));
      })
      .catch(() => {});
  }, []);

  // Connect WebSocket on mount
  useEffect(() => {
    chat.connect();
  }, [chat.connect]);

  // Reconnect when settings / mode change
  useEffect(() => {
    if (!chat.connected) chat.connect();
  }, [settings, mode]);

  // Refresh git branch whenever cwd changes
  useEffect(() => {
    if (!settings.cwd) return;
    fetchGitInfo(settings.cwd).then((g) => setGitBranch(g.branch)).catch(() => {});
  }, [settings.cwd]);

  const handleNewChat = useCallback(() => {
    chat.reset();
    setSessionCost(0);
    setSidebarRefresh((n) => n + 1);
  }, [chat]);

  // ⌘N / Ctrl+N starts a new chat, as the sidebar advertises. The desktop window
  // passes the shortcut through; a browser tab keeps it for itself.
  const newChatRef = useRef(handleNewChat);
  newChatRef.current = handleNewChat;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newChatRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleSelectSession = useCallback((id: string) => {
    void chat.loadSession(id).then((detail) => {
      if (!detail?.cwd) return;
      return openProjectFolder(detail.cwd)
        .then((project) => {
          setSettings((s) => ({ ...s, cwd: project.cwd }));
          fetchGitInfo(project.cwd).then((g) => setGitBranch(g.branch)).catch(() => {});
        })
        .catch(() => {});
    });
  }, [chat]);

  const handleSend = useCallback(
    (text: string, messageId?: string, images?: ChatImage[]) => {
      if (text.trim() === '/compact') {
        chat.compact();
        return;
      }
      if (!chat.connected) {
        chat.connect();
        setTimeout(() => chat.send(text, messageId, images), 300);
      } else {
        chat.send(text, messageId, images);
      }
      setTimeout(() => setSidebarRefresh((n) => n + 1), 2000);
    },
    [chat],
  );

  const handleCwdChange = useCallback((cwd: string) => {
    setSettings((s) => ({ ...s, cwd }));
    chat.reset();
    setSessionCost(0);
    setSidebarRefresh((n) => n + 1);
    fetchGitInfo(cwd).then((g) => setGitBranch(g.branch)).catch(() => {});
  }, [chat]);

  // The composer's mode menu: Ask/Collaborate in Chat, the permission mode in Code and Dvalin.
  const handleModeOptionChange = useCallback((id: string) => {
    if (workspaceMode === 'home') setHomeMode(id as HomeMode);
    else setCodePermissionMode(id as CodePermissionMode);
  }, [workspaceMode]);

  const handleModelChange = useCallback((model: string) => {
    setActiveModel(model);
    saveConfig({ llm: { provider: settings.provider, model } }).catch(() => {
      // Revert to server state if the save failed
      fetchConfig().then((cfg) => setActiveModel(cfg.llm.model ?? '')).catch(() => {});
    });
  }, [settings.provider]);

  // Stable, so the dialog's Escape listener isn't re-registered on every render.
  const closeSettings = useCallback(() => setShowSettings(false), []);

  const handleConfigClose = () => {
    setShowLLMConfig(false);
    fetchConfig()
      .then((cfg) => {
        setActiveModel(cfg.llm.model ?? '');
        setLlmMeta({
          apiKeySet: !!cfg.llm.apiKeySet,
          keySource: cfg.llm.keySource,
          apiKeyEnv: cfg.llm.apiKeyEnv,
        });
        setSettings((s) => ({ ...s, provider: cfg.llm.provider }));
      })
      .catch(() => {});
  };

  const usage = chat.lastUsage;

  // The conversation is named after what was first asked, as in the session list.
  const firstAsk = chat.messages.find((m) => m.role === 'user');
  const title = (firstAsk?.role === 'user' && firstAsk.content.trim().split('\n', 1)[0]) || 'New chat';

  // Accumulate cost whenever a turn finishes
  useEffect(() => {
    if (!usage) return;
    const turnCost = estimateCost(usage.inputTokens, usage.outputTokens, activeModel);
    setSessionCost((c) => c + turnCost);
  }, [usage, activeModel]);

  // Only claim a model is missing when nothing could supply one: an env var or a
  // gateway resolves the credential server-side, and local providers need none.
  const modelConfigured =
    llmMeta.apiKeySet ||
    llmMeta.keySource === 'env' ||
    llmMeta.keySource === 'gateway' ||
    settings.provider === 'ollama';

  const composer = (
    <Composer
      onSend={(text, images) => handleSend(text, undefined, images)}
      onClear={handleNewChat}
      onInterrupt={chat.interrupt}
      sending={chat.sending}
      disabled={false}
      cwd={settings.cwd || undefined}
      activeModel={activeModel}
      modelOptions={PROVIDERS.find((p) => p.id === settings.provider)?.models ?? []}
      onModelChange={handleModelChange}
      onOpenConfig={() => setShowLLMConfig(true)}
      modeOptions={workspaceMode === 'home' ? HOME_MODE_OPTIONS : CODE_MODE_OPTIONS}
      modeValue={workspaceMode === 'home' ? homeMode : codePermissionMode}
      onModeValueChange={handleModeOptionChange}
      onCwdChange={mode !== 'chat' ? handleCwdChange : undefined}
    />
  );

  return (
    <div className="flex h-full bg-bg text-fg">
      <Sidebar
        currentSessionId={chat.currentSessionId}
        runningSessionId={chat.runningSessionId}
        onNewChat={handleNewChat}
        onSelectSession={handleSelectSession}
        onOpenSettings={() => setShowSettings(true)}
        refreshKey={sidebarRefresh}
        mode={workspaceMode}
        onModeChange={setWorkspaceMode}
      />

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <div className="flex items-center justify-between gap-3 px-5 h-12 border-b border-border bg-surface flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-sm font-medium text-fg truncate" title={title}>{title}</h1>
            {!chat.connected && (
              <span
                role="status"
                className="flex-shrink-0 px-2 py-0.5 rounded-full border border-yellow-500/25 bg-yellow-500/10 text-[11px] text-warn-fg"
              >
                Connecting…
              </span>
            )}
            {gitBranch && (
              <span className="text-[11px] text-muted-fg font-mono flex-shrink-0 flex items-center gap-1">
                <GitBranch size={11} />
                {gitBranch}
              </span>
            )}
            {usage && (
              <span
                className="text-[11px] text-muted-fg font-mono flex-shrink-0 flex items-center gap-1.5"
                title={`Input: ${usage.inputTokens.toLocaleString()} · Output: ${usage.outputTokens.toLocaleString()}`}
              >
                <span>{(usage.inputTokens + usage.outputTokens).toLocaleString()} tok</span>
                {sessionCost > 0 && (
                  <span className="text-success-fg/70" title={`Session cost: ${formatCost(sessionCost)}`}>
                    · {formatCost(sessionCost)}
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {workspaceMode === 'dvalin' && !dvalinPanelOpen && (
              <button
                onClick={() => setDvalinPanelOpen(true)}
                className="px-2.5 py-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-success-fg text-[11px] flex items-center gap-1.5 hover:bg-emerald-500/20"
                title="Open Dvalin status panel"
              >
                <PanelRightOpen size={13} /> <ShieldCheck size={13} /> Dvalin status
              </button>
            )}
          </div>
        </div>

        {/* Workspace */}
        {workspaceMode === 'dvalin' ? (
          <div className="flex flex-1 min-h-0 min-w-0">
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              <ChatThread
                messages={chat.messages}
                mode={mode}
                onProceed={handleSend}
                onResend={handleSend}
              />
              {composer}
            </div>
            {dvalinPanelOpen && (
              <DvalinWorkspace
                cwd={settings.cwd || undefined}
                connected={chat.connected}
                sending={chat.sending}
                gitBranch={gitBranch}
                lastTurnOutcome={chat.lastTurnOutcome}
                modelConfigured={modelConfigured}
                onSend={handleSend}
                onReconnect={chat.connect}
                onConfigureModel={() => setShowLLMConfig(true)}
                onCwdChange={handleCwdChange}
                onClose={() => setDvalinPanelOpen(false)}
              />
            )}
          </div>
        ) : (
          <>
            <ChatThread
              messages={chat.messages}
              mode={mode}
              onProceed={handleSend}
              onResend={handleSend}
            />
            {composer}
          </>
        )}
      </div>

      <SettingsPanel
        open={showSettings}
        onClose={closeSettings}
        onDeletedAll={handleNewChat}
        onOpenLLMConfig={() => setShowLLMConfig(true)}
        activeProvider={settings.provider}
        activeModel={activeModel}
        apiKeySet={llmMeta.apiKeySet}
        keySource={llmMeta.keySource}
        apiKeyEnv={llmMeta.apiKeyEnv}
      />

      {/* LLM Config Modal */}
      {showLLMConfig && <LLMConfigModal onClose={handleConfigClose} />}

      {/* Approval dialog */}
      {chat.pendingApprovals[0] && (
        <ApprovalDialog
          approval={chat.pendingApprovals[0]}
          onRespond={chat.respondToApproval}
        />
      )}
    </div>
  );
}
