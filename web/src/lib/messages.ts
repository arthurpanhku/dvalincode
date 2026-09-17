import type { BackendChatMessage, ChatMessage, RecoveredTurn, ToolCallEvent } from '../types.ts';

/**
 * Session-restore mapping, kept out of the hook so it can be tested directly:
 * the hook needs React, this is a pure function of what the backend returned.
 */

/** Convert saved backend messages into UI chat messages for session restore */
export function mapBackendMessages(raw: BackendChatMessage[]): ChatMessage[] {
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

/**
 * Re-render the notices for turns a crash interrupted, after the conversation
 * itself has been restored.
 *
 * They belong at the end of the thread: the interrupted turn is the last thing
 * that happened, and its text never made it into the snapshot the messages come
 * from — only the journal kept it. Each keeps its original messageId so that
 * re-sending resolves the notice rather than opening a second one.
 */
export function withRecoveredNotices(messages: ChatMessage[], recovered: RecoveredTurn[] = []): ChatMessage[] {
  const known = new Set(
    messages.flatMap((message) => (message.role === 'recovered' ? [message.messageId] : [])),
  );
  const notices: ChatMessage[] = [];
  for (const turn of recovered) {
    if (known.has(turn.messageId)) continue;
    known.add(turn.messageId);
    notices.push({ role: 'recovered', messageId: turn.messageId, content: turn.content });
  }
  return notices.length > 0 ? [...messages, ...notices] : messages;
}

/**
 * Drop the notice a re-send has taken over. The re-sent turn appears as an
 * ordinary user message, so leaving the notice up would show the same text
 * twice and offer to send it again.
 */
export function withoutRecoveredNotice(messages: ChatMessage[], messageId: string): ChatMessage[] {
  return messages.filter((message) => !(message.role === 'recovered' && message.messageId === messageId));
}
