// ── Provider catalogue ────────────────────────────────────────────────────────
// Shared by LLMConfigModal (full settings) and Composer (quick model switcher).

export type ModelPreset = { label: string; model: string; description: string };

export type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  keyPlaceholder: string;
  models: ModelPreset[];
  needsKey: boolean;
};

export const PROVIDERS: Provider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'DeepSeek V3', model: 'deepseek-chat', description: 'Fast · general purpose' },
      { label: 'DeepSeek R1', model: 'deepseek-reasoner', description: 'Extended reasoning' },
      { label: 'DeepSeek Coder', model: 'deepseek-coder', description: 'Code specialist' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-proj-xxxxxxxx',
    needsKey: true,
    models: [
      { label: 'GPT-4o', model: 'gpt-4o', description: 'Most capable · multimodal' },
      { label: 'GPT-4o mini', model: 'gpt-4o-mini', description: 'Fast · affordable' },
      { label: 'o3', model: 'o3', description: 'Advanced reasoning' },
      { label: 'o1', model: 'o1', description: 'Deep reasoning' },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyPlaceholder: 'AIzaxxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Gemini 2.0 Flash', model: 'gemini-2.0-flash', description: 'Fast · long context' },
      { label: 'Gemini 1.5 Pro', model: 'gemini-1.5-pro', description: '2M context window' },
      { label: 'Gemini 2.5 Pro', model: 'gemini-2.5-pro-preview-06-05', description: 'Latest · strongest' },
    ],
  },
  {
    id: 'anthropic-openrouter',
    name: 'Claude',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Claude Sonnet 4.6', model: 'anthropic/claude-sonnet-4-6', description: 'Best for coding' },
      { label: 'Claude Opus 4.8', model: 'anthropic/claude-opus-4-8', description: 'Most capable' },
      { label: 'Claude Haiku 4.5', model: 'anthropic/claude-haiku-4-5-20251001', description: 'Fastest' },
    ],
  },
  {
    id: 'xai',
    name: 'xAI',
    baseUrl: 'https://api.x.ai/v1',
    keyPlaceholder: 'xai-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Grok 3', model: 'grok-3', description: 'Most capable' },
      { label: 'Grok 3 Mini', model: 'grok-3-mini', description: 'Fast · affordable' },
      { label: 'Grok 2', model: 'grok-2', description: 'Stable' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Mistral Large', model: 'mistral-large-latest', description: 'Most capable' },
      { label: 'Codestral', model: 'codestral-latest', description: 'Code specialist' },
      { label: 'Mistral Small', model: 'mistral-small-latest', description: 'Fast · cheap' },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPlaceholder: 'gsk_xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Llama 3.3 70B', model: 'llama-3.3-70b-versatile', description: 'Fastest open model' },
      { label: 'Llama 3.1 8B', model: 'llama-3.1-8b-instant', description: 'Ultra fast · small' },
      { label: 'Mixtral 8×7B', model: 'mixtral-8x7b-32768', description: '32k context' },
    ],
  },
  {
    id: 'together',
    name: 'Together',
    baseUrl: 'https://api.together.xyz/v1',
    keyPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Llama 3.3 70B', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', description: 'Fast open model' },
      { label: 'DeepSeek V3', model: 'deepseek-ai/DeepSeek-V3', description: 'Strong · cheap' },
      { label: 'Qwen 2.5 72B', model: 'Qwen/Qwen2.5-72B-Instruct-Turbo', description: 'Multilingual' },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyPlaceholder: 'fw_xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Llama 3.3 70B', model: 'accounts/fireworks/models/llama-v3p3-70b-instruct', description: 'Low latency' },
      { label: 'DeepSeek R1', model: 'accounts/fireworks/models/deepseek-r1', description: 'Reasoning' },
      { label: 'Qwen 2.5 Coder 32B', model: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct', description: 'Code' },
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    keyPlaceholder: 'pplx-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Sonar Pro', model: 'sonar-pro', description: 'With real-time search' },
      { label: 'Sonar', model: 'sonar', description: 'Fast · with search' },
      { label: 'Sonar Reasoning', model: 'sonar-reasoning', description: 'Search + reasoning' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Gemini 2.0 Flash', model: 'google/gemini-2.0-flash-001', description: 'Fast · long context' },
      { label: 'Llama 3.3 70B', model: 'meta-llama/llama-3.3-70b-instruct', description: 'Open source' },
      { label: 'DeepSeek V3', model: 'deepseek/deepseek-chat', description: 'Cheap · strong' },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Qwen Max', model: 'qwen-max', description: 'Most capable' },
      { label: 'Qwen 2.5 72B', model: 'qwen2.5-72b-instruct', description: 'Open · strong' },
      { label: 'Qwen 2.5 Coder', model: 'qwen2.5-coder-32b-instruct', description: 'Code specialist' },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyPlaceholder: 'sk-xxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'Kimi K1.5', model: 'kimi-k1.5', description: 'Extended reasoning' },
      { label: 'Moonshot 128k', model: 'moonshot-v1-128k', description: 'Long document' },
      { label: 'Moonshot 8k', model: 'moonshot-v1-8k', description: 'Fast · cheap' },
    ],
  },
  {
    id: 'zhipu',
    name: 'Zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyPlaceholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
    needsKey: true,
    models: [
      { label: 'GLM-4-Plus', model: 'glm-4-plus', description: 'Most capable' },
      { label: 'GLM-4-Flash', model: 'glm-4-flash', description: 'Free · fast' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    keyPlaceholder: 'ollama (any value)',
    needsKey: false,
    models: [
      { label: 'Qwen 2.5 Coder', model: 'qwen2.5-coder', description: 'Code specialist' },
      { label: 'Llama 3.2', model: 'llama3.2', description: 'General purpose' },
      { label: 'DeepSeek Coder V2', model: 'deepseek-coder-v2', description: 'Code generation' },
    ],
  },
  {
    id: 'cc-switch',
    name: 'CC-Switch',
    baseUrl: 'http://localhost:3456/v1',
    keyPlaceholder: 'managed by gateway',
    needsKey: false,
    models: [
      { label: 'Gateway default', model: 'deepseek-chat', description: 'Routed by gateway' },
      { label: 'Fast lane', model: 'gpt-4o-mini', description: 'Low-cost routing' },
      { label: 'Reasoning lane', model: 'anthropic/claude-sonnet-4-6', description: 'Strong coding route' },
    ],
  },
  {
    id: 'custom',
    name: 'Custom',
    baseUrl: '',
    keyPlaceholder: 'your-api-key',
    needsKey: false,
    models: [],
  },
];
