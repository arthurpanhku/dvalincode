import type { ProviderAdapter, ChatRequest, ChatResponse, ProviderConfig, ToolCall } from './types.js';
import { governedProviderFetch } from './egress.js';

export type OpenAIConfig = ProviderConfig & {
  name?: string;
};

export function createOpenAICompatibleProvider(config: OpenAIConfig): ProviderAdapter {
  const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
  const model = config.model ?? 'gpt-4o';

  function buildBody(request: ChatRequest, stream: boolean): string {
    const serializedMessages = request.messages.map(msg => {
      const m: Record<string, unknown> = { role: msg.role, content: msg.content };
      if (msg.tool_call_id) m.tool_call_id = msg.tool_call_id;
      if (msg.name) m.name = msg.name;
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        m.tool_calls = msg.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      return m;
    });

    const bodyObj: Record<string, unknown> = {
      model,
      messages: [
        ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
        ...serializedMessages,
      ],
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      stream,
    };

    if (request.tools && request.tools.length > 0) {
      bodyObj.tools = request.tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    if (stream) {
      bodyObj.stream_options = { include_usage: true };
    }

    return JSON.stringify(bodyObj);
  }

  function makeHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
  }

  async function chatStreaming(request: ChatRequest): Promise<ChatResponse> {
    const response = await governedProviderFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: makeHeaders(),
      body: buildBody(request, true),
      signal: request.signal,
    }, request, config.name ?? 'openai-compatible', baseUrl, model);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider API error ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let content = '';
    let lineBuffer = '';
    const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Capture usage (sent in last chunk with stream_options.include_usage)
          if (chunk.usage) {
            const u = chunk.usage as { prompt_tokens: number; completion_tokens: number };
            usage = u;
          }

          const choices = chunk.choices as Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined;
          const delta = choices?.[0]?.delta;
          if (!delta) continue;

          // Stream text content
          if (delta.content) {
            content += delta.content;
            request.onDelta?.(delta.content);
          }

          // Accumulate tool call fragments
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCallBuffers.has(idx)) {
                toolCallBuffers.set(idx, { id: '', name: '', arguments: '' });
              }
              const buf = toolCallBuffers.get(idx)!;
              if (tc.id) buf.id = tc.id;
              if (tc.function?.name) buf.name += tc.function.name;
              if (tc.function?.arguments) buf.arguments += tc.function.arguments;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = [...toolCallBuffers.values()]
      .filter(buf => buf.name)
      .map((buf, i) => ({
        id: buf.id || `tc_stream_${i}`,
        name: buf.name,
        arguments: buf.arguments,
      }));

    return {
      content,
      model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
    };
  }

  async function chatNonStreaming(request: ChatRequest): Promise<ChatResponse> {
    const response = await governedProviderFetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: makeHeaders(),
      body: buildBody(request, false),
      signal: request.signal,
    }, request, config.name ?? 'openai-compatible', baseUrl, model);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const choice = data.choices[0]?.message;
    let toolCalls: ToolCall[] | undefined;
    if (choice?.tool_calls && choice.tool_calls.length > 0) {
      toolCalls = choice.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));
    }

    return {
      content: choice?.content ?? '',
      model: data.model,
      toolCalls,
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  async function chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.onDelta) {
      return chatStreaming(request);
    }
    return chatNonStreaming(request);
  }

  return { name: config.name ?? 'openai-compatible', chat };
}
