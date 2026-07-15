import { governedProviderFetch } from './egress.js';
import type {
  CacheControl,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderConfig,
  TokenUsage,
  ToolCall,
} from './types.js';

export type AnthropicConfig = ProviderConfig & {
  name?: string;
  cacheTtl?: '5m' | '1h';
};

type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'tool_use'; id: string; name: string; input: unknown; cache_control?: CacheControl }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; cache_control?: CacheControl };

type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

export function normalizeAnthropicUsage(usage: AnthropicUsage): TokenUsage {
  const miss = usage.input_tokens ?? 0;
  const cached = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: miss + cached + write,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: cached,
    cacheMissInputTokens: miss,
    cacheWriteInputTokens: write,
  };
}

export function createAnthropicProvider(config: AnthropicConfig): ProviderAdapter {
  const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const model = config.model ?? 'claude-sonnet-4-6';
  const name = config.name ?? 'anthropic';
  const cacheControl: CacheControl = { type: 'ephemeral', ttl: config.cacheTtl ?? '5m' };

  function makeHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {}),
    };
  }

  function buildBody(request: ChatRequest, stream: boolean): string {
    const messages = convertMessages(request.messages, cacheControl);
    const body: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
      messages,
      stream,
    };

    if (request.system) {
      body.system = [{ type: 'text', text: request.system, cache_control: cacheControl }];
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool, index) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        ...(index === request.tools!.length - 1 ? { cache_control: cacheControl } : {}),
      }));
    }
    return JSON.stringify(body);
  }

  async function fetchMessages(request: ChatRequest, stream: boolean): Promise<Response> {
    const response = await governedProviderFetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: makeHeaders(),
      body: buildBody(request, stream),
      signal: request.signal,
    }, request, name, baseUrl, model);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider API error ${response.status}: ${text}`);
    }
    return response;
  }

  async function chatNonStreaming(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetchMessages(request, false);
    const data = await response.json() as {
      model?: string;
      stop_reason?: string | null;
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
      usage?: AnthropicUsage;
    };
    const content = (data.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('');
    const toolCalls = (data.content ?? [])
      .filter(block => block.type === 'tool_use' && block.name)
      .map((block, index): ToolCall => ({
        id: block.id ?? `tc_anthropic_${index}`,
        name: block.name!,
        arguments: JSON.stringify(block.input ?? {}),
      }));
    return {
      content,
      model: data.model ?? model,
      finishReason: data.stop_reason ?? undefined,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: data.usage ? normalizeAnthropicUsage(data.usage) : undefined,
    };
  }

  async function chatStreaming(request: ChatRequest): Promise<ChatResponse> {
    const response = await fetchMessages(request, true);
    if (!response.body) throw new Error('No response body for streaming');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolBuffers = new Map<number, { id: string; name: string; json: string }>();
    let content = '';
    let modelName = model;
    let finishReason: string | undefined;
    let usage: AnthropicUsage = {};
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const event of events) {
          const dataLine = event.split('\n').find(line => line.startsWith('data: '));
          if (!dataLine) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
          } catch {
            continue;
          }
          const type = payload.type;
          if (type === 'message_start') {
            const message = payload.message as { model?: string; usage?: AnthropicUsage } | undefined;
            modelName = message?.model ?? modelName;
            usage = mergeAnthropicUsage(usage, message?.usage);
          } else if (type === 'content_block_start') {
            const index = Number(payload.index ?? 0);
            const block = payload.content_block as { type?: string; id?: string; name?: string } | undefined;
            if (block?.type === 'tool_use') {
              toolBuffers.set(index, { id: block.id ?? `tc_anthropic_${index}`, name: block.name ?? '', json: '' });
            }
          } else if (type === 'content_block_delta') {
            const index = Number(payload.index ?? 0);
            const delta = payload.delta as { type?: string; text?: string; partial_json?: string } | undefined;
            if (delta?.type === 'text_delta' && delta.text) {
              content += delta.text;
              request.onDelta?.(delta.text);
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              const tool = toolBuffers.get(index);
              if (tool) tool.json += delta.partial_json;
            }
          } else if (type === 'message_delta') {
            const delta = payload.delta as { stop_reason?: string | null } | undefined;
            finishReason = delta?.stop_reason ?? finishReason;
            usage = mergeAnthropicUsage(usage, payload.usage as AnthropicUsage | undefined);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls = [...toolBuffers.values()]
      .filter(tool => tool.name)
      .map((tool): ToolCall => ({ id: tool.id, name: tool.name, arguments: tool.json || '{}' }));
    return {
      content,
      model: modelName,
      finishReason,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      usage: normalizeAnthropicUsage(usage),
    };
  }

  return {
    name,
    chat(request) {
      return request.onDelta ? chatStreaming(request) : chatNonStreaming(request);
    },
  };
}

function convertMessages(messages: ChatMessage[], defaultCache: CacheControl): AnthropicMessage[] {
  const converted: AnthropicMessage[] = [];
  for (const message of messages) {
    const next = convertMessage(message);
    if (!next || next.content.length === 0) continue;
    const prior = converted[converted.length - 1];
    if (prior?.role === next.role) prior.content.push(...next.content);
    else converted.push(next);
  }

  // Cache the growing stable conversation prefix. On the next iteration this
  // block is unchanged and the new assistant/tool suffix is appended after it.
  const lastMessage = converted[converted.length - 1];
  const lastBlock = lastMessage?.content[lastMessage.content.length - 1];
  if (lastBlock && isCacheable(lastBlock)) lastBlock.cache_control ??= defaultCache;
  return converted;
}

function convertMessage(message: ChatMessage): AnthropicMessage | undefined {
  const cache = message.cacheControl;
  if (message.role === 'tool') {
    if (!message.tool_call_id) return undefined;
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id,
        content: message.content,
        ...(cache ? { cache_control: cache } : {}),
      }],
    };
  }

  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const content: AnthropicBlock[] = [];
  if (message.content) {
    content.push({
      type: 'text',
      text: message.role === 'system' ? `[System note]\n${message.content}` : message.content,
      ...(cache ? { cache_control: cache } : {}),
    });
  }
  for (const toolCall of message.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: parseToolArguments(toolCall.arguments),
    });
  }
  return { role, content };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function isCacheable(block: AnthropicBlock): boolean {
  return block.type !== 'text' || block.text.length > 0;
}

function mergeAnthropicUsage(current: AnthropicUsage, next: AnthropicUsage | undefined): AnthropicUsage {
  if (!next) return current;
  return {
    input_tokens: next.input_tokens ?? current.input_tokens,
    output_tokens: next.output_tokens ?? current.output_tokens,
    cache_creation_input_tokens: next.cache_creation_input_tokens ?? current.cache_creation_input_tokens,
    cache_read_input_tokens: next.cache_read_input_tokens ?? current.cache_read_input_tokens,
  };
}
