const TRUSTED_PROVIDER_BASE_URLS: Record<string, readonly string[]> = {
  deepseek: ['https://api.deepseek.com/v1'],
  openai: ['https://api.openai.com/v1'],
  google: ['https://generativelanguage.googleapis.com/v1beta/openai'],
  'anthropic-openrouter': ['https://openrouter.ai/api/v1'],
  xai: ['https://api.x.ai/v1'],
  mistral: ['https://api.mistral.ai/v1'],
  groq: ['https://api.groq.com/openai/v1'],
  together: ['https://api.together.xyz/v1'],
  fireworks: ['https://api.fireworks.ai/inference/v1'],
  perplexity: ['https://api.perplexity.ai'],
  openrouter: ['https://openrouter.ai/api/v1'],
  qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1'],
  moonshot: ['https://api.moonshot.cn/v1'],
  zhipu: ['https://open.bigmodel.cn/api/paas/v4'],
  ollama: ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1'],
  'cc-switch': ['http://localhost:3456/v1', 'http://127.0.0.1:3456/v1'],
  gateway: ['http://localhost:3456/v1', 'http://127.0.0.1:3456/v1'],
};

export function requireTrustedProviderBaseUrl(provider: string, baseUrl: string | undefined): string {
  const trusted = TRUSTED_PROVIDER_BASE_URLS[provider];
  if (!trusted?.length) {
    throw new Error('Provider test supports trusted presets and localhost gateways only. Save custom providers without live testing.');
  }

  if (!baseUrl?.trim()) return trusted[0];
  const match = trusted.find(candidate => sameBaseUrl(candidate, baseUrl));
  if (!match) {
    throw new Error(`Provider test is limited to the trusted ${provider} endpoint or localhost gateway.`);
  }
  return match;
}

function sameBaseUrl(trusted: string, incoming: string): boolean {
  try {
    const a = new URL(trusted);
    const b = new URL(incoming);
    return a.protocol === b.protocol &&
      a.host === b.host &&
      trimTrailingSlash(a.pathname) === trimTrailingSlash(b.pathname);
  } catch {
    return false;
  }
}

function trimTrailingSlash(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed || '/';
}
