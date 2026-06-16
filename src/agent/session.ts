import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { AgentLoop } from './loop.js';
import type { AgentEventHandler, LoopResult } from './types.js';
import {
  MODE_PROMPT,
  MODE_TOOLS,
  CODE_PERMISSION_PROMPT,
  resolveApprovalMode,
  type AgentMode,
  type CodePermissionMode,
} from './modes.js';
import { createDvalinContext } from '../core/context.js';
import { scanProject } from '../core/projectScanner.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { createDefaultToolRegistry, type ToolRegistry } from '../tools/registry.js';
import { ProviderManager } from '../providers/manager.js';
import { ProviderPool } from '../providers/pool.js';
import type { ProviderAdapter } from '../providers/types.js';
import { readConfig } from '../server/configStore.js';
import { createSession, loadSession, saveSession, summarizeSession } from '../sessions/store.js';
import { renderReport } from '../audit/report.js';
import { renderRelevantMemory } from '../memory/store.js';

const execAsync = promisify(execFile);

export type ResolvedProvider = { provider: ProviderAdapter; providerId: string; model: string };

/**
 * Resolve the active provider from saved config: a provider pool takes priority
 * when enabled, otherwise the single `llm` config (optionally overridden by name).
 */
export async function resolveProvider(override?: string): Promise<ResolvedProvider> {
  const cfg = await readConfig();
  if (cfg.pool?.enabled && cfg.pool.entries.some(e => e.enabled)) {
    const pool = new ProviderPool(cfg.pool.entries, cfg.pool.policy);
    const picked = pool.next();
    const model = cfg.pool.entries.find(e => e.id === picked.id)?.model ?? 'unknown';
    return { provider: picked.adapter, providerId: picked.id, model };
  }
  const llm = cfg.llm;
  const providerName = override ?? llm.provider;
  const manager = new ProviderManager();
  manager.addOpenAI(providerName, { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model });
  return { provider: manager.get(providerName), providerId: providerName, model: llm.model ?? 'unknown' };
}

export type RunTurnInput = {
  /** The user's message (may contain @file references). */
  content: string;
  /** Resume an existing session; omit to start a new one. */
  sessionId?: string;
  /** Workspace root — caller is responsible for validating it is allowed. */
  cwd: string;
  mode: AgentMode;
  /** Only meaningful in Code mode (default: `auto`). */
  codePermissionMode?: CodePermissionMode;
  /** Override the configured provider by name. */
  providerOverride?: string;
  signal?: AbortSignal;
};

export type RunTurnHooks = {
  /** Fired once the session id is known (before the LLM runs). */
  onSessionId?: (sessionId: string) => void;
  /** Fired once the provider is resolved (before the LLM runs). */
  onProviderSelected?: (providerId: string, model: string) => void;
  /** Streams token deltas and tool events as the turn runs. */
  onEvent?: AgentEventHandler;
  /** Approval gate for writes/commands in Cowork / Code-Ask mode. */
  requestApproval?: (id: string, toolName: string, input: unknown) => Promise<boolean>;
};

export type RunTurnResult = {
  sessionId: string;
  result: LoopResult;
  /** Rendered Run Report Markdown, when an audit run was produced. */
  reportMarkdown?: string;
  providerId: string;
  model: string;
};

/**
 * Run one agent turn end-to-end, independent of transport. Both the WebSocket
 * handler (web GUI) and the terminal UI drive this same function, passing
 * transport-specific hooks for streaming and approval. Handles session
 * load/save, provider resolution, prompt assembly (mode + git + AGENTS.md +
 * @mentions), tool gating, and Run Report rendering.
 */
export async function runAgentTurn(input: RunTurnInput, hooks: RunTurnHooks = {}): Promise<RunTurnResult> {
  const { content, cwd, signal } = input;
  const mode = input.mode;
  const codePermissionMode: CodePermissionMode = input.codePermissionMode ?? 'auto';
  const approvalMode = resolveApprovalMode(mode, codePermissionMode);

  // ── Session ────────────────────────────────────────────────────────────
  let session;
  if (input.sessionId) {
    const loaded = await loadSession(input.sessionId);
    if (!loaded) throw new Error(`Session not found: ${input.sessionId}`);
    session = loaded;
  } else {
    session = createSession(cwd);
  }
  hooks.onSessionId?.(session.id);

  // ── Provider ───────────────────────────────────────────────────────────
  const { provider, providerId, model } = await resolveProvider(input.providerOverride);
  hooks.onProviderSelected?.(providerId, model);

  // ── Prompt assembly ──────────────────────────────────────────────────────
  const userContent = await expandAtMentions(content, cwd);

  const registry = createDefaultToolRegistry();
  const allowedTools = mode === 'code' && codePermissionMode === 'plan' ? MODE_TOOLS.chat : MODE_TOOLS[mode];
  registry.setAllowedTools(allowedTools);

  const systemPrompt = await buildSystemPrompt({
    cwd,
    mode,
    codePermissionMode,
    registry,
    userContent,
    sessionSummary: session.summary,
  });

  const turnMessage =
    mode === 'code' && codePermissionMode === 'plan'
      ? `Create a detailed step-by-step plan for the following task. Do NOT execute any steps yet.\n\nTask: ${userContent}`
      : userContent;

  // ── Run ──────────────────────────────────────────────────────────────────
  const loop = new AgentLoop({
    provider,
    registry,
    context: createDvalinContext({ cwd, approvalMode, requestApproval: hooks.requestApproval }),
    systemPrompt,
    audit: { model },
  });

  const result = await loop.processMessage(turnMessage, session.messages, hooks.onEvent, signal);

  // ── Persist ──────────────────────────────────────────────────────────────
  session.messages = result.messages;
  session.updatedAt = new Date().toISOString();
  session.summary = summarizeSession(session);
  await saveSession(session);

  // ── Run Report (best-effort) ─────────────────────────────────────────────
  let reportMarkdown: string | undefined;
  if (result.runId) {
    try {
      reportMarkdown = renderReport(result.runId);
    } catch {
      // never block a turn on report rendering
    }
  }

  return { sessionId: session.id, result, reportMarkdown, providerId, model };
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function buildSystemPrompt(opts: {
  cwd: string;
  mode: AgentMode;
  codePermissionMode: CodePermissionMode;
  registry: ToolRegistry;
  userContent: string;
  sessionSummary?: string;
}): Promise<string> {
  const { cwd, mode, codePermissionMode, registry } = opts;
  const tools = registry.list();
  const toolsDesc = tools.map(t => `- ${t.name}: ${t.description} (access: ${t.access})`).join('\n');

  const summary = await scanProject(cwd);
  const sessionContext = opts.sessionSummary ? `\nPrevious session summary: ${opts.sessionSummary}\n` : '';
  const localMemory = await renderRelevantMemory(cwd, opts.userContent, 8);

  const agentsMd = await readTextFileSafe(path.join(cwd, 'AGENTS.md'));
  const projectInstructions = agentsMd
    ? `\n=== PROJECT INSTRUCTIONS (from AGENTS.md) ===\n${agentsMd}\n`
    : '';

  let gitContext = '';
  try {
    const branch = (await execAsync('git', ['branch', '--show-current'], { cwd })).stdout.trim();
    const status = (await execAsync('git', ['status', '--porcelain'], { cwd })).stdout.trim();
    const changedCount = status ? status.split('\n').length : 0;
    gitContext = `\nGit branch: ${branch || '(detached)'}${changedCount > 0 ? ` · ${changedCount} changed file(s)` : ' · clean'}\n`;
  } catch {
    // Not a git repo — silently skip
  }

  return [
    'You are DvalinCode, an AI coding assistant.',
    MODE_PROMPT[mode],
    mode === 'code' ? CODE_PERMISSION_PROMPT[codePermissionMode] : '',
    '',
    `Project root: ${summary.root}`,
    `Files: ${summary.fileCount} files`,
    `Package manager(s): ${summary.packageManagers.join(', ') || 'none'}`,
    summary.signals.length > 0 ? `Signals: ${summary.signals.join(', ')}` : '',
    gitContext,
    projectInstructions,
    localMemory,
    sessionContext,
    '',
    '=== TOOLS ===',
    `You have ${tools.length} tools available. Use this syntax in your response:`,
    '',
    '@tool("tool_name", {"param": "value"})',
    '',
    'Available tools:',
    toolsDesc,
    '',
    'RULES:',
    '- Always read files before modifying them.',
    '- Prefer focused, surgical changes.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function readTextFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isIgnoredPath(filePath: string, patterns: string[]): boolean {
  return patterns.some(
    pattern =>
      filePath === pattern ||
      filePath.endsWith('/' + pattern) ||
      filePath.includes('/' + pattern + '/') ||
      filePath.startsWith(pattern + '/'),
  );
}

/** Expand @filepath references in the user's message by injecting file contents. */
export async function expandAtMentions(content: string, cwd: string): Promise<string> {
  const mentionRegex = /@([\w./\-]+)/g;
  const mentions = [...content.matchAll(mentionRegex)];
  if (mentions.length === 0) return content;

  const ignorePatterns = await loadIgnorePatterns(cwd);
  let result = content;
  for (const match of mentions) {
    const relPath = match[1];
    if (isIgnoredPath(relPath, ignorePatterns)) continue;
    try {
      const absPath = await resolveInsideWorkspace(cwd, relPath);
      const info = await stat(absPath);
      if (info.isDirectory() || info.size > 256_000) continue;
      const fileContent = await readFile(absPath, 'utf8');
      result = result.replace(match[0], `<file path="${relPath}">\n\`\`\`\n${fileContent}\n\`\`\`\n</file>`);
    } catch {
      // File not found — leave mention as-is
    }
  }
  return result;
}
