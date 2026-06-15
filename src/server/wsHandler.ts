import type { WebSocket } from 'ws';
import { runAgentTurn, resolveProvider } from '../agent/session.js';
import { loadSession, saveSession } from '../sessions/store.js';
import { estimateTokens, summarizeWithLLM, buildCompactedHistory } from '../agent/compact.js';
import type { AgentEvent } from '../agent/types.js';
import type { AgentMode, CodePermissionMode } from '../agent/modes.js';
import { resolveAllowedCwd } from './security.js';

type ClientMessage =
  | {
      type: 'send';
      content: string;
      sessionId?: string;
      cwd?: string;
      allowWrite?: boolean;
      allowExecute?: boolean;
      approvalMode?: 'readonly' | 'auto-edit' | 'full-auto' | 'bypass';
      codePermissionMode?: CodePermissionMode;
      mode?: AgentMode;
      provider?: string;
    }
  | { type: 'interrupt' }
  | { type: 'approval_response'; id: string; approved: boolean }
  | { type: 'compact'; sessionId?: string };

type ServerMessage =
  | { type: 'session_id'; sessionId: string }
  | { type: 'token_delta'; content: string }
  | { type: 'tool_call'; name: string; id: string; input: unknown }
  | { type: 'tool_result'; name: string; id: string; output: string; metadata?: Record<string, unknown> }
  | { type: 'tool_error'; name: string; id: string; error: string }
  | { type: 'approval_request'; id: string; toolName: string; input: unknown }
  | { type: 'response'; content: string }
  | { type: 'run_report'; runId: string; markdown: string }
  | { type: 'done'; sessionId: string; iterations: number; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'interrupted' }
  | { type: 'error'; message: string }
  | { type: 'compact_done'; tokensBefore: number; tokensAfter: number; summary: string }
  | { type: 'provider_selected'; providerId: string };

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(msg));
  }
}

export function handleWebSocket(ws: WebSocket): void {
  let currentAbort: AbortController | null = null;
  const pendingApprovals = new Map<string, (approved: boolean) => void>();

  ws.on('message', async (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type === 'interrupt') {
      currentAbort?.abort();
      currentAbort = null;
      send(ws, { type: 'interrupted' });
      return;
    }

    if (msg.type === 'approval_response') {
      const resolve = pendingApprovals.get(msg.id);
      if (resolve) {
        pendingApprovals.delete(msg.id);
        resolve(msg.approved);
      }
      return;
    }

    if (msg.type === 'compact') {
      if (!msg.sessionId) {
        send(ws, { type: 'error', message: 'compact requires a sessionId' });
        return;
      }
      const session = await loadSession(msg.sessionId);
      if (!session) {
        send(ws, { type: 'error', message: `Session not found: ${msg.sessionId}` });
        return;
      }
      let provider;
      try {
        ({ provider } = await resolveProvider());
      } catch (err) {
        send(ws, { type: 'error', message: `Provider error: ${err instanceof Error ? err.message : String(err)}` });
        return;
      }
      const tokensBefore = estimateTokens(session.messages);
      const summary = await summarizeWithLLM(session.messages, provider);
      const compacted = buildCompactedHistory(summary);
      const tokensAfter = estimateTokens(compacted);
      session.messages = compacted;
      session.updatedAt = new Date().toISOString();
      await saveSession(session);
      send(ws, { type: 'compact_done', tokensBefore, tokensAfter, summary });
      return;
    }

    if (msg.type !== 'send') return;

    currentAbort?.abort();
    const abort = new AbortController();
    currentAbort = abort;

    let cwd: string;
    try {
      cwd = await resolveAllowedCwd(msg.cwd);
    } catch (err) {
      send(ws, { type: 'error', message: err instanceof Error ? err.message : 'Workspace is not allowed' });
      return;
    }

    const mode: AgentMode = msg.mode ?? 'code';
    const codePermissionMode: CodePermissionMode = msg.codePermissionMode ?? 'auto';

    // Stream agent events to the browser. tool_result strips the large
    // internal-only `originalContent` field before it goes over the wire.
    const onEvent = (event: AgentEvent): void => {
      if (abort.signal.aborted) return;
      switch (event.type) {
        case 'token_delta':
          send(ws, { type: 'token_delta', content: event.content });
          break;
        case 'tool_call':
          send(ws, { type: 'tool_call', name: event.name, id: event.id, input: event.input });
          break;
        case 'tool_result': {
          const { originalContent: _omit, ...safeMetadata } = (event.metadata ?? {}) as Record<string, unknown> & {
            originalContent?: unknown;
          };
          send(ws, {
            type: 'tool_result',
            name: event.name,
            id: event.id,
            output: event.output,
            metadata: Object.keys(safeMetadata).length > 0 ? safeMetadata : undefined,
          });
          break;
        }
        case 'tool_error':
          send(ws, { type: 'tool_error', name: event.name, id: event.id, error: event.error });
          break;
      }
    };

    // Approval round-trip: park the resolver until the browser replies, and
    // auto-reject if the turn is interrupted.
    const requestApproval = (id: string, toolName: string, input: unknown): Promise<boolean> => {
      return new Promise((resolve) => {
        if (abort.signal.aborted) {
          resolve(false);
          return;
        }
        pendingApprovals.set(id, resolve);
        send(ws, { type: 'approval_request', id, toolName, input });
        abort.signal.addEventListener(
          'abort',
          () => {
            if (pendingApprovals.has(id)) {
              pendingApprovals.delete(id);
              resolve(false);
            }
          },
          { once: true },
        );
      });
    };

    try {
      const turn = await runAgentTurn(
        {
          content: msg.content,
          sessionId: msg.sessionId,
          cwd,
          mode,
          codePermissionMode,
          providerOverride: msg.provider,
          signal: abort.signal,
        },
        {
          onSessionId: (sessionId) => send(ws, { type: 'session_id', sessionId }),
          onProviderSelected: (providerId) => send(ws, { type: 'provider_selected', providerId }),
          onEvent,
          requestApproval,
        },
      );

      if (abort.signal.aborted) return;

      send(ws, { type: 'response', content: turn.result.output });
      if (turn.reportMarkdown && turn.result.runId) {
        send(ws, { type: 'run_report', runId: turn.result.runId, markdown: turn.reportMarkdown });
      }
      send(ws, {
        type: 'done',
        sessionId: turn.sessionId,
        iterations: turn.result.iterationsUsed,
        usage: turn.result.usage,
      });
    } catch (err) {
      if (abort.signal.aborted) {
        send(ws, { type: 'interrupted' });
        return;
      }
      send(ws, { type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (currentAbort === abort) currentAbort = null;
    }
  });

  ws.on('close', () => {
    currentAbort?.abort();
  });
}
