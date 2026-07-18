import type { BackendChatMessage, ChatMessage, RecoveredTurn, ToolCallEvent } from '../types.ts';

/** Convert saved backend messages into UI chat messages for session restore. */
export function mapBackendMessages(raw: BackendChatMessage[], recoveredTurns: RecoveredTurn[] = []): ChatMessage[] {
  const result: ChatMessage[] = [];
  let assistantBuf: { content: string; toolCalls: ToolCallEvent[] } | null = null;
  // Map from tool_call_id to index in assistantBuf.toolCalls.
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
      const toolCalls: ToolCallEvent[] = (msg.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: (() => { try { return JSON.parse(tc.arguments); } catch { return tc.arguments; } })(),
        status: 'done' as const,
      }));
      assistantBuf = { content: msg.content, toolCalls };
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
        const tc = assistantBuf.toolCalls[idx]!;
        if (isError) {
          assistantBuf.toolCalls[idx] = { ...tc, error: output, status: 'error' };
        } else {
          assistantBuf.toolCalls[idx] = { ...tc, output, status: 'done' };
        }
      } else {
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
  for (const recovered of recoveredTurns) {
    result.push({ role: 'recovered', ...recovered });
  }
  return result;
}
