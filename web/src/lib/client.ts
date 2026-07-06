import type { ServerEvent, SessionMeta, AppConfig, BackendChatMessage, ApprovalMode, AgentMode, ProviderPoolConfig, CodePermissionMode, SarifImportResult, RemediationFinding, RemediationWorktreeResult, RemediationCase, RemediationCaseStatus, SkillSummary, LLMConfig, Profile } from '../types.ts';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

export type SendOptions = {
  content: string;
  sessionId?: string;
  messageId?: string;
  cwd?: string;
  approvalMode?: ApprovalMode;
  mode?: AgentMode;
  codePermissionMode?: CodePermissionMode;
  provider?: string;
};

export type WsCallbacks = {
  onEvent: (event: ServerEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class DvalinClient {
  private ws: WebSocket | null = null;
  private callbacks: WsCallbacks | null = null;

  connect(callbacks: WsCallbacks): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.callbacks = callbacks;
      callbacks.onOpen?.();
      return;
    }

    this.callbacks = callbacks;
    this.ws = new WebSocket(WS_URL);

    this.ws.onopen = () => {
      this.callbacks?.onOpen?.();
    };

    this.ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as ServerEvent;
        this.callbacks?.onEvent(event);
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.callbacks?.onClose?.();
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  send(opts: SendOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(
      JSON.stringify({
        type: 'send',
        content: opts.content,
        sessionId: opts.sessionId,
        messageId: opts.messageId,
        cwd: opts.cwd,
        approvalMode: opts.approvalMode,
        mode: opts.mode ?? 'code',
        codePermissionMode: opts.codePermissionMode,
        provider: opts.provider,
      }),
    );
  }

  interrupt(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
  }

  sendApprovalResponse(id: string, approved: boolean): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'approval_response', id, approved }));
    }
  }

  compact(sessionId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    this.ws.send(JSON.stringify({ type: 'compact', sessionId }));
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const client = new DvalinClient();

// REST API helpers
export async function fetchSessions(): Promise<SessionMeta[]> {
  const res = await fetch('/api/sessions');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  return Array.isArray(data) ? (data as SessionMeta[]) : [];
}

export async function deleteSession(id: string): Promise<void> {
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
}

export async function deleteAllSessions(): Promise<number> {
  const res = await fetch('/api/sessions', { method: 'DELETE' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { deleted?: number };
  return data.deleted ?? 0;
}

/** Trigger a browser download of a URL that sets Content-Disposition. */
function triggerDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Download a session's conversation as a Markdown transcript. */
export function downloadSessionMarkdown(id: string): void {
  triggerDownload(`/api/sessions/${encodeURIComponent(id)}/markdown`);
}

/** Download a portable bundle of all local data (for migrating machines). */
export function downloadDataExport(includeAudit = true): void {
  triggerDownload(`/api/data/export${includeAudit ? '' : '?audit=0'}`);
}

export function downloadSkill(name: string): void {
  triggerDownload(`/api/skills/${encodeURIComponent(name)}/download`);
}

export async function fetchSkills(): Promise<SkillSummary[]> {
  const res = await fetch('/api/skills');
  if (!res.ok) return [];
  return res.json() as Promise<SkillSummary[]>;
}

export async function importSkillBundle(bundle: unknown): Promise<SkillSummary> {
  const res = await fetch('/api/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<SkillSummary>;
}

export async function deleteSkill(name: string): Promise<void> {
  const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
}

export type ImportResult = { written: number; skipped: number; total: number };

/** Restore local data from a bundle previously exported. */
export async function importDataBundle(bundle: unknown, overwrite = true): Promise<ImportResult> {
  const res = await fetch(`/api/data/import${overwrite ? '' : '?overwrite=0'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<ImportResult>;
}

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<AppConfig>;
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<AppConfig>;
}

export type ProviderTestResult = {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  error?: string;
};

export async function testProviderConfig(llm: Partial<LLMConfig>): Promise<ProviderTestResult> {
  const res = await fetch('/api/config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llm }),
  });
  const data = (await res.json().catch(() => ({}))) as ProviderTestResult;
  if (!res.ok) {
    return { ...data, ok: false, error: data.error ?? `HTTP ${res.status}` };
  }
  return data;
}

export type SessionDetail = {
  id: string;
  cwd: string;
  messages: BackendChatMessage[];
  summary?: string;
};

export async function fetchSessionDetail(id: string): Promise<SessionDetail> {
  const res = await fetch(`/api/sessions/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SessionDetail>;
}

export async function fetchFiles(cwd: string): Promise<string[]> {
  const res = await fetch(`/api/files?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) return [];
  return res.json() as Promise<string[]>;
}

export type GitInfo = { branch: string | null; lastCommit: string | null };

export async function fetchGitInfo(cwd: string): Promise<GitInfo> {
  try {
    const res = await fetch(`/api/git?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) return { branch: null, lastCommit: null };
    return res.json() as Promise<GitInfo>;
  } catch {
    return { branch: null, lastCommit: null };
  }
}

export async function importSarifReport(report: unknown, cwd?: string): Promise<SarifImportResult> {
  const res = await fetch('/api/remediation/sarif', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report, cwd }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<SarifImportResult>;
}

export async function runLocalSecurityScan(cwd?: string): Promise<SarifImportResult> {
  const res = await fetch('/api/remediation/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<SarifImportResult>;
}

export async function fetchRemediationCases(cwd?: string): Promise<RemediationCase[]> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const res = await fetch(`/api/remediation/cases${query}`);
  if (!res.ok) return [];
  return res.json() as Promise<RemediationCase[]>;
}

export async function saveRemediationCases(cwd: string | undefined, findings: RemediationFinding[]): Promise<RemediationCase[]> {
  const res = await fetch('/api/remediation/cases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, findings }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<RemediationCase[]>;
}

export async function updateRemediationCase(id: string, patch: { status?: RemediationCaseStatus }): Promise<RemediationCase> {
  const res = await fetch(`/api/remediation/cases/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<RemediationCase>;
}

export async function createRemediationWorktree(cwd: string, finding: RemediationFinding, caseId?: string): Promise<RemediationWorktreeResult> {
  const res = await fetch('/api/remediation/worktree', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, finding, caseId }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<RemediationWorktreeResult>;
}

// ── Profiles ─────────────────────────────────────────────────────────────────

export async function fetchProfiles(): Promise<Record<string, Profile>> {
  try {
    const res = await fetch('/api/config/profiles');
    if (!res.ok) return {};
    return res.json() as Promise<Record<string, Profile>>;
  } catch {
    return {};
  }
}

export async function saveProfile(name: string, profile: Profile): Promise<void> {
  await fetch(`/api/config/profiles/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
}

export async function deleteProfile(name: string): Promise<void> {
  await fetch(`/api/config/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function applyProfile(name: string): Promise<AppConfig> {
  const res = await fetch(`/api/config/profiles/${encodeURIComponent(name)}/apply`, { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<AppConfig>;
}

// ── Provider pool ─────────────────────────────────────────────────────────────

export async function fetchPool(): Promise<ProviderPoolConfig> {
  try {
    const res = await fetch('/api/config/pool');
    if (!res.ok) return { enabled: false, policy: 'round-robin', entries: [] };
    return res.json() as Promise<ProviderPoolConfig>;
  } catch {
    return { enabled: false, policy: 'round-robin', entries: [] };
  }
}

export async function savePool(pool: ProviderPoolConfig): Promise<ProviderPoolConfig> {
  const res = await fetch('/api/config/pool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pool),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ProviderPoolConfig>;
}

// ── Playbook ──────────────────────────────────────────────────────────────────

export type PlaybookRoutine = { label: string; prompt: string };

export async function fetchPlaybook(cwd: string): Promise<PlaybookRoutine[]> {
  try {
    const res = await fetch(`/api/playbook?cwd=${encodeURIComponent(cwd)}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { routines: PlaybookRoutine[] };
    return Array.isArray(data.routines) ? data.routines : [];
  } catch {
    return [];
  }
}

export async function savePlaybook(cwd: string, routines: PlaybookRoutine[]): Promise<void> {
  await fetch('/api/playbook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, routines }),
  });
}

// ── Projects ─────────────────────────────────────────────────────────────────

async function projectPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/projects/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function openProjectFolder(cwd?: string): Promise<{ cwd: string }> {
  return projectPost('open', { cwd });
}

export async function cloneGitProject(url: string, parentDir?: string, name?: string): Promise<{ cwd: string }> {
  return projectPost('clone', { url, parentDir, name });
}

export async function createGitWorktree(cwd: string, branch: string, path: string, createBranch: boolean): Promise<{ cwd: string }> {
  return projectPost('worktree', { cwd, branch, path, createBranch });
}
