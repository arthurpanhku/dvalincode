export type LLMConfig = {
  provider: string;
  apiKey?: string;
  apiKeySet?: boolean;
  keySource?: ProviderKeySource;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
};

export type ProviderKeySource = 'stored' | 'env' | 'gateway';

export type Profile = {
  provider: string;
  apiKey?: string;
  keySource?: ProviderKeySource;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
};

export type RotationPolicy = 'round-robin' | 'random' | 'weighted-random';

export type PoolEntry = {
  id: string;
  provider: string;
  apiKey?: string;
  keySource?: ProviderKeySource;
  apiKeyEnv?: string;
  baseUrl?: string;
  model?: string;
  weight: number;
  enabled: boolean;
};

export type ProviderPoolConfig = {
  enabled: boolean;
  policy: RotationPolicy;
  entries: PoolEntry[];
};

export type AppConfig = {
  llm: LLMConfig;
  profiles?: Record<string, Profile>;
  pool?: ProviderPoolConfig;
};

export type SkillSummary = {
  name: string;
  title: string;
  description: string;
  version: string;
  builtIn?: boolean;
  tools?: string[];
  installed: boolean;
};

export type SessionMeta = {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  goal?: string;
  summary?: string;
  messageCount: number;
};

/** Backend ChatMessage shape (from sessions store) */
export type BackendChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
};

export type ToolCallEvent = {
  id: string;
  name: string;
  input: unknown;
  output?: string;
  metadata?: Record<string, unknown>;
  error?: string;
  status: 'running' | 'done' | 'error';
  startedAt?: number;
  completedAt?: number;
};

export type ChatMessage =
  | { role: 'user'; content: string; messageId?: string }
  | {
      role: 'assistant';
      content: string;
      toolCalls: ToolCallEvent[];
      pending?: boolean;
      replayed?: boolean;
      startedAt?: number;
      completedAt?: number;
    }
  | { role: 'compact'; tokensBefore: number; tokensAfter: number }
  | { role: 'report'; runId: string; markdown: string };

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | 'bypass';
export type AgentMode = 'chat' | 'cowork' | 'code' | 'dvalin';
export type WorkspaceMode = 'home' | 'code' | 'dvalin';
export type HomeMode = 'chat' | 'cowork';
export type CodePermissionMode = 'ask' | 'plan' | 'auto' | 'bypass';

export type RemediationFinding = {
  id: string;
  source: string;
  ruleId: string;
  ruleName?: string;
  severity: 'error' | 'warning' | 'note' | 'none';
  securitySeverity?: string;
  message: string;
  path: string;
  startLine?: number;
  endLine?: number;
  helpUri?: string;
  tags: string[];
  snippet?: string;
  prompt: string;
};

export type SarifImportResult = {
  source: string;
  findings: RemediationFinding[];
  totalResults: number;
  skippedResults: number;
};

export type RemediationWorktreeResult = {
  cwd: string;
  branch: string;
  baseCwd: string;
  prompt: string;
};

export type RemediationCaseStatus = 'open' | 'worktree_ready' | 'fixing' | 'verified' | 'dismissed';

export type RemediationCase = {
  id: string;
  findingId: string;
  source: string;
  cwd?: string;
  ruleId: string;
  severity: RemediationFinding['severity'];
  securitySeverity?: string;
  message: string;
  path: string;
  startLine?: number;
  tags: string[];
  prompt: string;
  status: RemediationCaseStatus;
  worktreeCwd?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
};

export type DvalinScannerId = 'builtin' | 'semgrep' | 'trivy' | 'osv-scanner';

export type DvalinScanner = {
  id: DvalinScannerId;
  name: string;
  category: 'sast' | 'supply-chain' | 'secrets' | 'misconfiguration';
  description: string;
  available: boolean;
  installCommand?: string;
  homepage: string;
};

export type DvalinScannerRun = DvalinScanner & {
  status: 'completed' | 'missing' | 'error';
  findings: number;
  durationMs: number;
  error?: string;
};

export type DvalinScanResult = {
  id: string;
  source: 'Dvalin Security Suite';
  startedAt: string;
  completedAt: string;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: RemediationFinding[];
  totalResults: number;
  skippedResults: number;
  scanners: DvalinScannerRun[];
  metrics: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    files: number;
    rules: number;
  };
  cases: RemediationCase[];
};

export type DiffLine = { type: 'add' | 'remove' | 'keep'; content: string };

export type PendingApproval = {
  id: string;
  toolName: string;
  input: unknown;
};

export type ServerEvent =
  | { type: 'session_id'; sessionId: string }
  | { type: 'token_delta'; content: string }
  | { type: 'tool_call'; name: string; id: string; input: unknown }
  | { type: 'tool_result'; name: string; id: string; output: string; metadata?: Record<string, unknown> }
  | { type: 'tool_error'; name: string; id: string; error: string }
  | { type: 'approval_request'; id: string; toolName: string; input: unknown }
  | { type: 'response'; content: string }
  | { type: 'run_report'; runId: string; markdown: string }
  | {
      type: 'done';
      sessionId: string;
      iterations: number;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens?: number;
        cacheMissInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
      replayed?: boolean;
    }
  | { type: 'interrupted' }
  | { type: 'error'; message: string }
  | { type: 'compact_done'; tokensBefore: number; tokensAfter: number; summary: string }
  | { type: 'provider_selected'; providerId: string };
