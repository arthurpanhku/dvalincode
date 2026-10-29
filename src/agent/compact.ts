import type { ChatMessage, ChatRequest, ProviderAdapter, ToolDef } from '../providers/types.js';

export function estimateTokens(messages: ChatMessage[]): number {
  const total = messages.reduce(
    (acc, m) => acc + roughTokens(m.content ?? '') + roughTokens(JSON.stringify(m.tool_calls ?? [])),
    0,
  );
  return Math.ceil(total);
}

/** Estimate the complete provider request, not just visible chat content. */
export function estimateRequestTokens(
  messages: ChatMessage[],
  systemPrompt: string,
  tools: ToolDef[] = [],
): number {
  return estimateTokens(messages) + Math.ceil(roughTokens(systemPrompt) + roughTokens(JSON.stringify(tools)));
}

/**
 * About four ASCII characters per token, but roughly one token per CJK (or
 * other non-ASCII) character -- counting those at a quarter too would
 * underestimate a Chinese conversation about fourfold.
 */
function roughTokens(text: string): number {
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0x7f) nonAscii++;
  }
  return (text.length - nonAscii) / 4 + nonAscii;
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
    maxTokens: 1_500,
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
    summaryMessage(summary),
    { role: 'user', content: 'Context was compacted. Continue from the Pending list.' },
    { role: 'assistant', content: 'Understood. I have the session summary and am ready to continue.' },
  ];
}

export function summaryMessage(summary: string): ChatMessage {
  return { role: 'system', content: `[Conversation summary]\n\n${summary}` };
}

/** The task message kept verbatim when a turn is compacted mid-way. */
export function compactedTaskMessage(task: string): ChatMessage {
  return {
    role: 'user',
    content: `${task}\n\n[Context was compacted: the summary above covers the earlier work on this task. Continue from where it left off.]`,
  };
}

/**
 * The latest messages that fit in `budget` tokens, starting at an assistant
 * message so that no tool result is kept without the call it answers.
 */
export function recentTail(messages: ChatMessage[], budget: number): ChatMessage[] {
  let start = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    used += estimateTokens([messages[i]!]);
    if (used > budget) break;
    if (messages[i]!.role === 'assistant') start = i;
  }
  return messages.slice(start);
}
