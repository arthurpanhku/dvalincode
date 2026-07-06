export type ProviderKeySource = 'stored' | 'env' | 'gateway';

export type ProviderSecretConfig = {
  apiKey?: string;
  keySource?: ProviderKeySource;
  apiKeyEnv?: string;
};

export function resolveApiKey(config: ProviderSecretConfig): string | undefined {
  if (config.keySource === 'gateway') return undefined;
  if (config.keySource === 'env') {
    const envName = config.apiKeyEnv?.trim();
    return envName ? process.env[envName] : undefined;
  }
  return config.apiKey;
}

export function keySourceLabel(config: ProviderSecretConfig): string {
  if (config.keySource === 'gateway') return 'gateway';
  if (config.keySource === 'env') return 'environment variable';
  return config.apiKey ? 'stored' : 'missing';
}
