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
