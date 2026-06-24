import type { ChatMessage, ChatRequest, ProviderAdapter } from '../providers/types.js';

export function estimateTokens(messages: ChatMessage[]): number {
  const total = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0);
  return Math.ceil(total / 4);
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
): Promise<string> {
  const transcript = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1000)}`)
    .join('\n\n');

  const resp = await provider.chat({
    messages: [{ role: 'user', content: `${COMPACT_PROMPT}\n\n---\n${transcript}` }],
    maxTokens: 600,
    temperature: 0.3,
    runtime,
  });
  return resp.content;
}

export function buildCompactedHistory(summary: string): ChatMessage[] {
  return [
    { role: 'system', content: `## Session Summary\n\n${summary}` },
    { role: 'user', content: 'Context was compacted. Continue from the Pending list.' },
    { role: 'assistant', content: 'Understood. I have the session summary and am ready to continue.' },
  ];
}
