import { useState, useCallback, useRef } from 'react';
import { client, fetchSessionDetail } from '../lib/client.ts';
import type { ChatMessage, ToolCallEvent, ServerEvent, BackendChatMessage, ApprovalMode, AgentMode, PendingApproval, CodePermissionMode } from '../types.ts';

export type UseChatOptions = {
  sessionId?: string;
  cwd?: string;
  approvalMode?: ApprovalMode;
  mode?: AgentMode;
  codePermissionMode?: CodePermissionMode;
};

export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
};

function updateLastPendingAssistant(
  messages: ChatMessage[],
  update: (message: Extract<ChatMessage, { role: 'assistant' }>) => Extract<ChatMessage, { role: 'assistant' }>,
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && msg.pending) {
      const next = [...messages];
      next[i] = update(msg);
      return next;
    }
  }
  return messages;
}

/** Convert saved backend messages into UI chat messages for session restore */
function mapBackendMessages(raw: BackendChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let assistantBuf: { content: string; toolCalls: ToolCallEvent[] } | null = null;
  // Map from tool_call_id → index in assistantBuf.toolCalls
  const tcIndex = new Map<string, number>();

  const flushAssistant = () => {
    if (assistantBuf) {
      result.push({ role: 'assistant', content: assistantBuf.content, toolCalls: assistantBuf.toolCalls, pending: false });
      assistantBuf = null;
      tcIndex.clear();
    }
  };

  for (const msg of raw) {
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      flushAssistant();
      result.push({ role: 'user', content: msg.content });
      continue;
    }

    if (msg.role === 'assistant') {
      flushAssistant();
      // Build tool calls from native tool_calls array
      const toolCalls: ToolCallEvent[] = (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: (() => { try { return JSON.parse(tc.arguments); } catch { return tc.arguments; } })(),
        status: 'done' as const,
      }));
      assistantBuf = { content: msg.content, toolCalls };
      // Register id→index for matching tool results
      toolCalls.forEach((tc, i) => tcIndex.set(tc.id, i));
      continue;
    }

    if (msg.role === 'tool' && assistantBuf) {
      const id = msg.tool_call_id ?? '';
      const name = msg.name ?? 'unknown';
      const output = msg.content.replace(/^\[Tool \w+ result\]:\n/, '').replace(/^\[Tool \w+ error\]: /, '');
      const isError = msg.content.startsWith(`[Tool ${name} error]:`);

      const idx = id ? tcIndex.get(id) : undefined;
      if (idx !== undefined) {
        // Update existing tool call with its result
        const tc = assistantBuf.toolCalls[idx]!;
        if (isError) {
          assistantBuf.toolCalls[idx] = { ...tc, error: output, status: 'error' };
        } else {
          assistantBuf.toolCalls[idx] = { ...tc, output, status: 'done' };
        }
      } else {
        // Orphan tool result — create an entry
        assistantBuf.toolCalls.push({
          id: id || `tc_${assistantBuf.toolCalls.length}`,
          name,
          input: {},
          output: isError ? undefined : output,
          error: isError ? output : undefined,
          status: isError ? 'error' : 'done',
        });
      }
    }
  }
  flushAssistant();
  return result;
}

export function useChat(opts: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [sending, setSending] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(opts.sessionId);
  const [lastUsage, setLastUsage] = useState<UsageStats | undefined>();
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const pendingToolCallsRef = useRef<Map<string, ToolCallEvent>>(new Map());

  const connect = useCallback(() => {
    client.connect({
      onOpen: () => setConnected(true),
      onClose: () => { setConnected(false); setSending(false); },
      onEvent: (event: ServerEvent) => {
        switch (event.type) {
          case 'session_id':
            setCurrentSessionId(event.sessionId);
            break;

          case 'token_delta':
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.pending) {
                return [...prev.slice(0, -1), { ...last, content: last.content + event.content }];
              }
              return prev;
            });
            break;

          case 'tool_call': {
            const tc: ToolCallEvent = { id: event.id, name: event.name, input: event.input, status: 'running' };
            pendingToolCallsRef.current.set(event.id, tc);
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.pending) {
                return [...prev.slice(0, -1), { ...last, toolCalls: [...last.toolCalls, tc] }];
              }
              return prev;
            });
            break;
          }

          case 'approval_request':
            setPendingApprovals((prev) => [...prev, { id: event.id, toolName: event.toolName, input: event.input }]);
            break;

          case 'tool_result':
            pendingToolCallsRef.current.set(event.id, {
              ...(pendingToolCallsRef.current.get(event.id) ?? { id: event.id, name: event.name, input: {} }),
              output: event.output, metadata: event.metadata, status: 'done',
            });
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.pending) {
                return [...prev.slice(0, -1), {
                  ...last,
                  toolCalls: last.toolCalls.map((t) =>
                    t.id === event.id ? { ...t, output: event.output, metadata: event.metadata, status: 'done' as const } : t,
                  ),
                }];
              }
              return prev;
            });
            break;

          case 'tool_error':
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.pending) {
                return [...prev.slice(0, -1), {
                  ...last,
                  toolCalls: last.toolCalls.map((t) =>
                    t.id === event.id ? { ...t, error: event.error, status: 'error' as const } : t,
                  ),
                }];
              }
              return prev;
            });
            break;

          case 'response':
            // For non-streaming providers, or the final assembled response
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && last.pending && !last.content) {
                return [...prev.slice(0, -1), { ...last, content: event.content }];
              }
              return prev;
            });
            break;

          case 'run_report':
            setMessages((prev) => [...prev, { role: 'report', runId: event.runId, markdown: event.markdown }]);
            break;

          case 'done':
            if (event.replayed && event.sessionId) {
              void fetchSessionDetail(event.sessionId)
                .then((detail) => {
                  const uiMessages = mapBackendMessages(detail.messages);
                  for (let i = uiMessages.length - 1; i >= 0; i--) {
                    const msg = uiMessages[i];
                    if (msg?.role === 'assistant') {
                      uiMessages[i] = { ...msg, replayed: true };
                      break;
                    }
                  }
                  setMessages(uiMessages);
                })
                .catch(() => {
                  setMessages((prev) =>
                    updateLastPendingAssistant(prev, (msg) => ({ ...msg, pending: false, replayed: true })),
                  );
                });
            } else {
              setMessages((prev) => updateLastPendingAssistant(prev, (msg) => ({ ...msg, pending: false })));
            }
            if (event.usage) setLastUsage(event.usage);
            pendingToolCallsRef.current.clear();
            setPendingApprovals([]);
            setSending(false);
            break;

          case 'interrupted':
            setMessages((prev) => updateLastPendingAssistant(prev, (msg) => ({
              ...msg,
              content: msg.content || '*(interrupted)*',
              pending: false,
            })));
            pendingToolCallsRef.current.clear();
            setPendingApprovals([]);
            setSending(false);
            break;

          case 'error':
            setMessages((prev) => {
              const next = updateLastPendingAssistant(prev, (msg) => ({
                ...msg,
                content: `**Error:** ${event.message}`,
                pending: false,
              }));
              if (next !== prev) {
                return next;
              }
              return [...prev, { role: 'assistant', content: `**Error:** ${event.message}`, toolCalls: [], pending: false }];
            });
            setSending(false);
            break;

          case 'compact_done':
            setMessages((prev) => [
              ...prev,
              { role: 'compact', tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter },
            ]);
            setSending(false);
            break;
        }
      },
    });
  }, []);

  const send = useCallback(
    (content: string) => {
      if (sending) return;
      const messageId = crypto.randomUUID();
      setSending(true);
      pendingToolCallsRef.current.clear();
      setMessages((prev) => [
        ...prev,
        { role: 'user', content, messageId },
        { role: 'assistant', content: '', toolCalls: [], pending: true },
      ]);
      try {
        client.send({
          content,
          messageId,
          sessionId: currentSessionId,
          cwd: opts.cwd,
          approvalMode: opts.approvalMode,
          mode: opts.mode,
          codePermissionMode: opts.codePermissionMode,
        });
      } catch (err) {
        setMessages((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: `**Error:** ${err instanceof Error ? err.message : 'Not connected'}`, toolCalls: [], pending: false },
        ]);
        setSending(false);
      }
    },
    [sending, currentSessionId, opts.cwd, opts.approvalMode, opts.mode, opts.codePermissionMode],
  );

  const compact = useCallback(() => {
    if (!currentSessionId) return;
    setSending(true);
    client.compact(currentSessionId);
  }, [currentSessionId]);

  const respondToApproval = useCallback((id: string, approved: boolean) => {
    setPendingApprovals((prev) => prev.filter((a) => a.id !== id));
    client.sendApprovalResponse(id, approved);
  }, []);

  const interrupt = useCallback(() => {
    client.interrupt();
  }, []);

  /** Load a saved session from the backend and restore its messages into the UI */
  const loadSession = useCallback(async (id: string) => {
    try {
      const detail = await fetchSessionDetail(id);
      const uiMessages = mapBackendMessages(detail.messages);
      setMessages(uiMessages);
      setCurrentSessionId(id);
      return detail;
    } catch {
      // Session load failed — just set the ID and start fresh
      setCurrentSessionId(id);
      return undefined;
    }
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setCurrentSessionId(undefined);
    pendingToolCallsRef.current.clear();
    setSending(false);
    setLastUsage(undefined);
  }, []);

  return { messages, connected, sending, currentSessionId, lastUsage, pendingApprovals, connect, send, compact, interrupt, loadSession, reset, respondToApproval };
}
