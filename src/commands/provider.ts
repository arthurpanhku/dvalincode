import type { Command } from 'commander';
import { readConfig, writeConfig, type LLMConfig } from '../server/configStore.js';
import { createOpenAICompatibleProvider } from '../providers/openaiCompatible.js';
import { keySourceLabel, resolveApiKey } from '../providers/secrets.js';
import { requireTrustedProviderBaseUrl } from '../providers/trustedBaseUrls.js';

const PROVIDER_PRESETS: Record<string, Pick<LLMConfig, 'baseUrl' | 'model' | 'keySource'>> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keySource: 'stored' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keySource: 'stored' },
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', keySource: 'gateway' },
  'cc-switch': { baseUrl: 'http://localhost:3456/v1', model: 'deepseek-chat', keySource: 'gateway' },
  gateway: { baseUrl: 'http://localhost:3456/v1', model: 'deepseek-chat', keySource: 'gateway' },
};

type SetOptions = {
  baseUrl?: string;
  model?: string;
  key?: string;
  env?: string;
  gateway?: boolean;
};

export function registerProviderCommand(program: Command): void {
  const provider = program
    .command('provider')
    .description('Manage LLM providers, API keys, and gateway settings');

  provider
    .command('list')
    .description('Show the active provider and saved profiles')
    .action(async () => {
      const config = await readConfig();
      console.log('Active provider');
      printProfile(config.llm, true);

      const profiles = Object.entries(config.profiles ?? {});
      if (profiles.length > 0) {
        console.log('\nSaved profiles');
        for (const [name, profile] of profiles) {
          printProfile({ ...profile, provider: `${name} (${profile.provider})` }, false);
        }
      }

      if (config.pool?.enabled) {
        const enabled = config.pool.entries.filter(e => e.enabled);
        console.log(`\nProvider pool: enabled (${enabled.length} active, ${config.pool.policy})`);
      }
    });

  provider
    .command('set')
    .description('Set the active provider')
    .argument('<provider>', 'provider id, e.g. deepseek, openai, ollama, cc-switch')
    .option('--base-url <url>', 'OpenAI-compatible base URL')
    .option('--model <name>', 'default model name')
    .option('--key <value>', 'store an API key locally')
    .option('--env <name>', 'read the API key from an environment variable')
    .option('--gateway', 'external gateway manages credentials; do not store an API key')
    .action(async (providerId: string, options: SetOptions) => {
      const config = await readConfig();
      const llm = applyProviderOptions(baseProviderConfig(config.llm, providerId, options), options);

      await writeConfig({ ...config, llm });
      console.log(`Active provider set to ${llm.provider}`);
      printProfile(llm, true);
    });

  const key = provider.command('key').description('Manage the active provider key source');

  key
    .command('set')
    .description('Set the key source for a provider and make it active')
    .argument('<provider>', 'provider id')
    .option('--key <value>', 'store an API key locally')
    .option('--env <name>', 'read the API key from an environment variable')
    .option('--gateway', 'external gateway manages credentials; do not store an API key')
    .action(async (providerId: string, options: SetOptions) => {
      if (!options.key && !options.env && !options.gateway) {
        throw new Error('Choose one key source: --key, --env, or --gateway');
      }
      const config = await readConfig();
      const llm = applyProviderOptions(baseProviderConfig(config.llm, providerId, options), options);
      await writeConfig({ ...config, llm });
      console.log(`Key source updated for ${providerId}: ${keySourceLabel(llm)}`);
    });

  provider
    .command('test')
    .description('Test the active provider or a temporary provider id')
    .argument('[provider]', 'optional provider id to test')
    .option('--base-url <url>', 'temporary base URL')
    .option('--model <name>', 'temporary model')
    .option('--key <value>', 'temporary API key')
    .option('--env <name>', 'temporary API key environment variable')
    .option('--gateway', 'gateway manages credentials')
    .action(async (providerId: string | undefined, options: SetOptions) => {
      const config = await readConfig();
      const id = providerId ?? config.llm.provider;
      const llm = applyProviderOptions(
        providerId ? baseProviderConfig(config.llm, id, options) : { ...config.llm, ...options, provider: id },
        options,
      );

      if (!llm.model) throw new Error('Model is required. Pass --model <name>.');
      const baseUrl = requireTrustedProviderBaseUrl(llm.provider, llm.baseUrl);
      const started = Date.now();
      const adapter = createOpenAICompatibleProvider({
        name: llm.provider,
        apiKey: resolveApiKey(llm),
        baseUrl,
        model: llm.model,
      });
      await adapter.chat({
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 8,
        temperature: 0,
      });
      console.log(`Provider OK: ${llm.provider} · ${llm.model} (${Date.now() - started} ms)`);
    });
}

function baseProviderConfig(current: LLMConfig, providerId: string, options: SetOptions): LLMConfig {
  const preset = PROVIDER_PRESETS[providerId] ?? {};
  const sameProvider = current.provider === providerId;
  return {
    provider: providerId,
    baseUrl: options.baseUrl ?? (sameProvider ? current.baseUrl ?? preset.baseUrl : preset.baseUrl),
    model: options.model ?? (sameProvider ? current.model ?? preset.model : preset.model),
    keySource: sameProvider ? current.keySource ?? preset.keySource ?? 'stored' : preset.keySource ?? 'stored',
    apiKey: sameProvider ? current.apiKey : undefined,
    apiKeyEnv: sameProvider ? current.apiKeyEnv : undefined,
  };
}

function applyProviderOptions(llm: LLMConfig, options: SetOptions): LLMConfig {
  if (options.gateway) {
    return { ...llm, keySource: 'gateway', apiKey: undefined, apiKeyEnv: undefined };
  }
  if (options.env) {
    return { ...llm, keySource: 'env', apiKey: undefined, apiKeyEnv: options.env };
  }
  if (options.key) {
    return { ...llm, keySource: 'stored', apiKey: options.key, apiKeyEnv: undefined };
  }
  return llm;
}

function printProfile(profile: Pick<LLMConfig, 'provider' | 'baseUrl' | 'model' | 'apiKey' | 'keySource' | 'apiKeyEnv'>, active: boolean): void {
  const prefix = active ? '*' : '-';
  console.log(`${prefix} ${profile.provider}`);
  console.log(`  model: ${profile.model ?? '(unset)'}`);
  console.log(`  baseUrl: ${profile.baseUrl ?? '(default)'}`);
  console.log(`  key: ${keySourceLabel(profile)}`);
}
