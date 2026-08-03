import { useEffect, useState, useCallback } from 'react';
import { PanelRightOpen, ShieldCheck } from 'lucide-react';
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
import type { ChatSettings } from './components/SettingsPanel.tsx';
import type { AgentMode, ApprovalMode, CodePermissionMode, HomeMode, ProviderKeySource, WorkspaceMode } from './types.ts';

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
  const [settings, setSettings] = useState<ChatSettings>({
    cwd: '',
    provider: 'deepseek',
    approvalMode: 'full-auto',
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
    (text: string) => {
      if (text.trim() === '/compact') {
        chat.compact();
        return;
      }
      if (!chat.connected) {
        chat.connect();
        setTimeout(() => chat.send(text), 300);
      } else {
        chat.send(text);
      }
      setTimeout(() => setSidebarRefresh((n) => n + 1), 2000);
    },
    [chat],
  );

  const handleModeChange = useCallback((m: WorkspaceMode) => {
    setWorkspaceMode(m);
    const nextMode: AgentMode = m === 'home' ? homeMode : m;
    setSettings((s) => ({
      ...s,
      approvalMode: nextMode === 'code' || nextMode === 'dvalin' ? CODE_APPROVAL[codePermissionMode] : MODE_APPROVAL[nextMode],
    }));
  }, [codePermissionMode, homeMode]);

  const handleHomeModeChange = useCallback((next: HomeMode) => {
    setHomeMode(next);
    setSettings((current) => ({ ...current, approvalMode: MODE_APPROVAL[next] }));
  }, []);

  const handleCwdChange = useCallback((cwd: string) => {
    setSettings((s) => ({ ...s, cwd }));
    chat.reset();
    setSessionCost(0);
    setSidebarRefresh((n) => n + 1);
    fetchGitInfo(cwd).then((g) => setGitBranch(g.branch)).catch(() => {});
  }, [chat]);

  const handleCodePermissionModeChange = useCallback((next: CodePermissionMode) => {
    setCodePermissionMode(next);
    setSettings((s) => ({ ...s, approvalMode: CODE_APPROVAL[next] }));
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setActiveModel(model);
    saveConfig({ llm: { provider: settings.provider, model } }).catch(() => {
      // Revert to server state if the save failed
      fetchConfig().then((cfg) => setActiveModel(cfg.llm.model ?? '')).catch(() => {});
    });
  }, [settings.provider]);

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

  // Total tool calls in current session (live progress tracking)
  const totalTools = chat.messages.reduce((sum, msg) => {
    if (msg.role === 'assistant') return sum + msg.toolCalls.length;
    return sum;
  }, 0);

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
      onSend={handleSend}
      onClear={handleNewChat}
      onInterrupt={chat.interrupt}
      sending={chat.sending}
      disabled={false}
      cwd={settings.cwd || undefined}
      activeModel={activeModel}
      modelOptions={PROVIDERS.find((p) => p.id === settings.provider)?.models ?? []}
      onModelChange={handleModelChange}
      onOpenConfig={() => setShowLLMConfig(true)}
      codePermissionMode={mode === 'code' || mode === 'dvalin' ? codePermissionMode : undefined}
      onCodePermissionModeChange={mode === 'code' || mode === 'dvalin' ? handleCodePermissionModeChange : undefined}
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
        onSend={handleSend}
        refreshKey={sidebarRefresh}
        mode={workspaceMode}
        onModeChange={handleModeChange}
        homeMode={homeMode}
        onHomeModeChange={handleHomeModeChange}
      />

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-surface">
          <div className="flex items-center gap-2 min-w-0">
            {chat.currentSessionId && (
              <span className="text-xs text-muted-fg font-mono truncate max-w-[160px]">
                {chat.currentSessionId}
              </span>
            )}
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                chat.connected ? 'bg-emerald-500' : 'bg-red-500/70'
              }`}
              title={chat.connected ? 'Connected' : 'Disconnected'}
            />
            {gitBranch && (
              <span className="text-[11px] text-muted-fg/80 font-mono flex-shrink-0 flex items-center gap-1">
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="opacity-60">
                  <path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm0 2.122a2.25 2.25 0 1 0-1.5 0v.878A2.25 2.25 0 0 0 5.75 8.5h1.5v2.128a2.251 2.251 0 1 0 1.5 0V8.5h1.5a2.25 2.25 0 0 0 2.25-2.25v-.878a2.25 2.25 0 1 0-1.5 0v.878a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 5 6.25v-.878zm3.75 7.378a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0zm3-8.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/>
                </svg>
                {gitBranch}
              </span>
            )}
            {totalTools > 0 && (
              <span className="text-[11px] text-muted-fg/60 font-mono flex-shrink-0">
                {totalTools} tool{totalTools === 1 ? '' : 's'}
              </span>
            )}
            {usage && (
              <span
                className="text-[11px] text-muted-fg/70 font-mono flex-shrink-0 flex items-center gap-1.5"
                title={`Input: ${usage.inputTokens.toLocaleString()} · Output: ${usage.outputTokens.toLocaleString()}`}
              >
                <span>{(usage.inputTokens + usage.outputTokens).toLocaleString()} tok</span>
                {sessionCost > 0 && (
                  <span className="text-emerald-500/70" title={`Session cost: ${formatCost(sessionCost)}`}>
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
                className="px-2.5 py-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-300 text-[11px] flex items-center gap-1.5 hover:bg-emerald-500/20"
                title="Open Dvalin status panel"
              >
                <PanelRightOpen size={13} /> <ShieldCheck size={13} /> Dvalin status
              </button>
            )}
            <SettingsPanel
              onOpenLLMConfig={() => setShowLLMConfig(true)}
              activeProvider={settings.provider}
              activeModel={activeModel}
              apiKeySet={llmMeta.apiKeySet}
              keySource={llmMeta.keySource}
              apiKeyEnv={llmMeta.apiKeyEnv}
            />
          </div>
        </div>

        {/* Workspace */}
        {workspaceMode === 'dvalin' ? (
          <div className="flex flex-1 min-h-0 min-w-0">
            <div className="flex flex-col flex-1 min-w-0 min-h-0">
              <div className="px-5 py-2 border-b border-border bg-surface text-[11px] font-medium text-emerald-300 flex items-center gap-1.5">
                <ShieldCheck size={12} /> Dvalin remediation agent
              </div>
              <ChatThread
                messages={chat.messages}
                connected={chat.connected}
                mode={mode}
                onProceed={handleSend}
              />
              {composer}
            </div>
            {dvalinPanelOpen && (
              <DvalinWorkspace
                cwd={settings.cwd || undefined}
                connected={chat.connected}
                sending={chat.sending}
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
              connected={chat.connected}
              mode={mode}
              onProceed={handleSend}
            />
            {composer}
          </>
        )}
      </div>

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
