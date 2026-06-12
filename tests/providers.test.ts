import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ProviderAdapter } from '../src/providers/types.js';
import { ProviderManager } from '../src/providers/manager.js';

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
    const mod = await import('../src/providers/openaiCompatible.js');
    const provider = mod.createOpenAICompatibleProvider({ apiKey: '000000000000000', model: 'gpt-4o' });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
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
