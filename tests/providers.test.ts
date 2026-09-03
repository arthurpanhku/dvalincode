import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatRequest, ProviderAdapter } from '../src/providers/types.js';
import { ProviderManager } from '../src/providers/manager.js';
import { resolvePolicy } from '../src/core/policy.js';
import { AuditSink, readRecords } from '../src/audit/log.js';

function completionResponse(content = 'ok'): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    model: 'test-model',
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ProviderAdapter interface', () => {
  it('defines the contract for a provider', () => {
    const mock: ProviderAdapter = {
      name: 'mock',
      async chat(req: ChatRequest) {
        return { content: `Echo: ${req.messages[0]?.content}`, model: 'mock' };
      },
    };
    expect(mock.name).toBe('mock');
  });

  it('mock provider echoes input', async () => {
    const mock: ProviderAdapter = {
      name: 'mock',
      async chat(req) {
        return { content: `Echo: ${req.messages[0]?.content}`, model: 'mock' };
      },
    };
    const res = await mock.chat({
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.content).toBe('Echo: hello');
  });

  it('openai provider rejects with invalid key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })));
    const mod = await import('../src/providers/openaiCompatible.js');
    const provider = mod.createOpenAICompatibleProvider({ apiKey: '000000000000000', model: 'gpt-4o' });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    vi.unstubAllGlobals();
  });

  it('openai provider exposes configured model and name', async () => {
    const mod = await import('../src/providers/openaiCompatible.js');
    const provider = mod.createOpenAICompatibleProvider({
      baseUrl: 'https://httpbin.org',
      apiKey: 'test-key',
      model: 'deepseek-chat',
    });
    expect(provider.name).toBe('openai-compatible');
  });

  it('normalizes DeepSeek and OpenAI prompt-cache token fields', async () => {
    const { normalizeOpenAIUsage } = await import('../src/providers/openaiCompatible.js');
    expect(normalizeOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 20,
    })).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cachedInputTokens: 80,
      cacheMissInputTokens: 20,
    });
    expect(normalizeOpenAIUsage({
      prompt_tokens: 100,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 60 },
    })).toMatchObject({ cachedInputTokens: 60, cacheMissInputTokens: 40 });
  });

  it('anthropic adapter emits cache breakpoints, parses tools, and accounts cache usage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'claude-test',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { filePath: 'a.ts' } },
      ],
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 70,
        cache_read_input_tokens: 20,
        output_tokens: 4,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { createAnthropicProvider } = await import('../src/providers/anthropic.js');
    const provider = createAnthropicProvider({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-test',
    });

    const response = await provider.chat({
      system: 'stable system',
      messages: [{ role: 'user', content: 'inspect it' }],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object' } }],
    });

    expect(response.toolCalls).toEqual([{
      id: 'tool_1',
      name: 'read_file',
      arguments: '{"filePath":"a.ts"}',
    }]);
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 4,
      cachedInputTokens: 20,
      cacheMissInputTokens: 10,
      cacheWriteInputTokens: 70,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init.body));
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    vi.unstubAllGlobals();
  });
});

describe('governed provider egress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks network: off before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'secret prompt' }],
      runtime: { policy: resolvePolicy([{ network: 'off' }]) },
    })).rejects.toThrow('network egress is disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows the configured origin with endpoint-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'endpoint-only' }]) },
    });

    expect(response.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('preserves the provider finish reason for completion gating', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      model: 'test-model',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    });
    expect(response.finishReason).toBe('length');
  });

  it('allows an explicitly configured localhost gateway', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse('local-ok'));
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://localhost:3456/v1', model: 'm' });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    });

    expect(response.content).toBe('local-ok');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks metadata URLs before fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'http://169.254.169.254/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow('restricted network address');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks a cross-origin redirect with endpoint-only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'https://other.example/chat/completions' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'endpoint-only' }]) },
    })).rejects.toThrow('configured model endpoint');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('blocks redirects to metadata URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow('restricted network address');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── PCP-1 MUST assertions that were implemented but never asserted ──────
  //
  // Each is bypass-proof: deleting the corresponding guard in
  // src/providers/egress.ts turns exactly the matching test red. Verified by
  // hand; see the PR body.

  it('EG-4: bounds the redirect chain instead of returning the last response', async () => {
    // Every hop redirects, forever. Without the bound the loop would either run
    // until the mock ran out or hand back the final 307 as though it were a
    // completion -- the second is the dangerous one, because the caller cannot
    // tell a redirect from an answer.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'https://provider.example/v1/chat/completions' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow(/exceeded \d+ redirects/);

    // The chain is bounded, not merely reported: the request count is finite
    // and small. An unbounded loop would have kept calling the mock.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it('EG-5: rejects a non-http(s) scheme before any bytes are sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'ftp://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow(/unsupported protocol/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('EG-5: rejects a non-http(s) scheme reached through a redirect', async () => {
    // The scheme check has to hold on every hop, not just the configured base:
    // a redirect is attacker-influenced in a way the base URL is not.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'file:///etc/passwd' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow(/unsupported protocol/);
    // One call for the original hop; nothing was sent to the file: destination.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('EG-6: rejects a URL carrying embedded credentials before any bytes are sent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completionResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({
      baseUrl: 'https://user:pass@provider.example/v1',
      model: 'm',
    });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow(/embedded credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('EG-6: rejects embedded credentials reached through a redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 307, headers: { location: 'https://user:pass@provider.example/v1/chat/completions' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    await expect(provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    })).rejects.toThrow(/embedded credentials/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('allows redirects when network policy is on', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: 'https://other.example/chat/completions' } }),
      )
      .mockResolvedValueOnce(completionResponse('redirected'));
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      runtime: { policy: resolvePolicy([{ network: 'on' }]) },
    });

    expect(response.content).toBe('redirected');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(secondInit.headers).has('authorization')).toBe(false);
  });

  it('audits only minimized provider metadata', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-provider-audit-'));
    const sink = new AuditSink('provider-audit', dir);
    const fetchMock = vi.fn().mockResolvedValue(completionResponse());
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({
      name: 'work',
      apiKey: 'sk-do-not-log',
      baseUrl: 'https://provider.example/private/v1',
      model: 'm',
    });

    await provider.chat({
      messages: [{ role: 'user', content: 'prompt-do-not-log' }],
      runtime: { policy: resolvePolicy([{ network: 'endpoint-only' }]), audit: sink },
    });

    const serialized = JSON.stringify(readRecords('provider-audit', dir));
    expect(serialized).toContain('"origin":"https://provider.example"');
    expect(serialized).not.toContain('prompt-do-not-log');
    expect(serialized).not.toContain('sk-do-not-log');
    expect(serialized).not.toContain('/private/v1');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ProviderManager', () => {
  afterEach(() => {
    delete process.env.DVALINCODE_PROVIDER;
    delete process.env.DVALINCODE_API_KEY;
    delete process.env.DVALINCODE_BASE_URL;
    delete process.env.DVALINCODE_MODEL;
  });

  it('provider manager loads from env', () => {
    process.env.DVALINCODE_API_KEY = 'sk-test-key';
    process.env.DVALINCODE_MODEL = 'deepseek-chat';

    const mgr = new ProviderManager().loadFromEnv();
    const provider = mgr.get('deepseek');
    expect(provider.name).toBe('deepseek');
  });

  it('provider manager throws for unknown provider', () => {
    const mgr = new ProviderManager();
    expect(() => mgr.get('nope')).toThrow('Unknown provider: nope');
  });

  it('addProfile registers the profile provider and returns its name', () => {
    const mgr = new ProviderManager();
    const profiles = {
      work: { provider: 'openai', apiKey: 'sk-work', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
      local: { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' },
    };

    const name = mgr.addProfile(profiles, 'work');

    expect(name).toBe('openai');
    // The provider is now resolvable under the profile's provider name.
    expect(mgr.get('openai').name).toBe('openai');
  });

  it('registers the native Anthropic adapter for direct profiles', () => {
    const mgr = new ProviderManager();
    mgr.addProfile({
      claude: { provider: 'anthropic', apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6' },
    }, 'claude');
    expect(mgr.get('anthropic').name).toBe('anthropic');
  });

  it('addProfile throws with available names when the profile is missing', () => {
    const mgr = new ProviderManager();
    const profiles = { work: { provider: 'openai' } };
    expect(() => mgr.addProfile(profiles, 'nope')).toThrow('Profile not found: nope. Available: work');
  });

  it('addProfile throws a clear message when no profiles are configured', () => {
    const mgr = new ProviderManager();
    expect(() => mgr.addProfile(undefined, 'work')).toThrow('No profiles configured');
  });
});

describe('openaiCompatible streaming conformance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Builds a mock streaming Response whose body yields the given SSE chunks
  // (each chunk is the raw bytes of one or more `data: ...` lines).
  function sseResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('surfaces streaming token deltas in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":", "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    const deltas: string[] = [];
    const response = await provider.chat({
      messages: [{ role: 'user', content: 'hello' }],
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(['Hel', 'lo', ', ', 'world']);
    expect(response.content).toBe('Hello, world');
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('accumulates streamed tool-call fragments into a single tool call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"x=1"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const { createOpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
    const provider = createOpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', model: 'm' });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'read a file' }],
      onDelta: () => {},
    });

    expect(response.toolCalls).toEqual([{
      id: 'call_1',
      name: 'read_file',
      arguments: 'x=1',
    }]);
    expect(response.finishReason).toBe('tool_calls');
  });
});
