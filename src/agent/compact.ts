import type { ChatMessage, ChatRequest, ProviderAdapter, ToolDef } from '../providers/types.js';

export function estimateTokens(messages: ChatMessage[]): number {
  const total = messages.reduce(
    (acc, m) => acc + (m.content?.length ?? 0) + JSON.stringify(m.tool_calls ?? []).length,
    0,
  );
  return Math.ceil(total / 4);
}

/** Estimate the complete provider request, not just visible chat content. */
export function estimateRequestTokens(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDef[] = [],
): number {
  return estimateTokens(messages) + Math.ceil((systemPrompt.length + JSON.stringify(tools).length) / 4);
}

const COMPACT_PROMPT = `Summarize this coding session using exactly this format:

## Goal
<one sentence: what the user is trying to accomplish>

## Completed
- <task or file changed, with file path if applicable>

## Key decisions
- <non-obvious choice or API design decision>

## Pending
- <remaining work items in priority order>

Be concise. Each bullet is one line. Omit sections with no content.`;

export async function summarizeWithLLM(
  messages: ChatMessage[],
  provider: ProviderAdapter,
  runtime?: ChatRequest['runtime'],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = compactTranscript(messages);

  const resp = await provider.chat({
    messages: [{ role: 'user', content: `${COMPACT_PROMPT}\n\n---\n${transcript}` }],
    maxTokens: 600,
    temperature: 0.3,
    runtime,
    signal,
  });
  return resp.content;
}

/**
 * Keep compaction itself safely below the model context window while retaining
 * both the original objective and the latest implementation/tool state.
 */
function compactTranscript(messages: ChatMessage[], maxChars = 64_000): string {
  const entries = messages
    // Preserve an earlier compacted summary when compaction happens more than
    // once in a long turn; ordinary system messages are supplied separately.
    .filter((m) => m.role !== 'system' || m.content.startsWith('[Conversation summary]'))
    .map((m) => {
      const label = m.role === 'system'
        ? 'Previous session summary'
        : m.role === 'user'
          ? 'User'
          : m.role === 'assistant'
            ? 'Assistant'
            : `Tool ${m.name ?? ''}`.trim();
      const calls = m.tool_calls?.length ? `\nTool calls: ${JSON.stringify(m.tool_calls)}` : '';
      return `${label}: ${m.content}${calls}`.slice(0, 4_000);
    });

  const first = entries[0];
  const selected: string[] = [];
  let used = first ? first.length : 0;
  for (let i = entries.length - 1; i >= (first ? 1 : 0); i--) {
    const entry = entries[i]!;
    if (used + entry.length + 2 > maxChars) break;
    selected.unshift(entry);
    used += entry.length + 2;
  }
  return [first, ...selected].filter((entry): entry is string => Boolean(entry)).join('\n\n');
}

export function buildCompactedHistory(summary: string): ChatMessage[] {
  return [
    { role: 'system', content: `[Conversation summary]\n\n${summary}` },
    { role: 'user', content: 'Context was compacted. Continue from the Pending list.' },
    { role: 'assistant', content: 'Understood. I have the session summary and am ready to continue.' },
  ];
}
