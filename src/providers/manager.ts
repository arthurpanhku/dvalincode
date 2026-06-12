import type { ProviderAdapter } from './types.js';
import type { OpenAIConfig } from './openaiCompatible.js';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';

export type ConfiguredProvider = {
  name: string;
  adapter: ProviderAdapter;
};

/** A named provider profile as stored in ~/.dvalincode/config.json. */
export type ProviderProfile = {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export class ProviderManager {
  private providers = new Map<string, ProviderAdapter>();

  addOpenAI(name: string, config: OpenAIConfig): this {
    const adapter = createOpenAICompatibleProvider({ ...config, name });
    this.providers.set(name, adapter);
    return this;
  }

  get(name: string): ProviderAdapter {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`Unknown provider: ${name}. Available: ${[...this.providers.keys()].join(', ')}`);
    return provider;
  }

  list(): ConfiguredProvider[] {
    return [...this.providers.entries()].map(([name, adapter]) => ({ name, adapter }));
  }

  /** Load from env: DVALINCODE_PROVIDER, DVALINCODE_API_KEY, DVALINCODE_BASE_URL, DVALINCODE_MODEL */
  loadFromEnv(): this {
    const providerName = process.env.DVALINCODE_PROVIDER ?? 'deepseek';
    const apiKey = process.env.DVALINCODE_API_KEY;
    const baseUrl = process.env.DVALINCODE_BASE_URL;
    const model = process.env.DVALINCODE_MODEL;

    this.addOpenAI(providerName, { apiKey, baseUrl, model });
    return this;
  }

  /**
   * Register the provider described by a named profile and return its provider
   * name (for a subsequent `get`). Throws if the profile is not found, listing
   * the available profile names.
   */
  addProfile(profiles: Record<string, ProviderProfile> | undefined, name: string): string {
    const profile = profiles?.[name];
    if (!profile) {
      const available = Object.keys(profiles ?? {});
      const hint = available.length ? ` Available: ${available.join(', ')}` : ' No profiles configured.';
      throw new Error(`Profile not found: ${name}.${hint}`);
    }
    this.addOpenAI(profile.provider, {
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      model: profile.model,
    });
    return profile.provider;
  }
}
