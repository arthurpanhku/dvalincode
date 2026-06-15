/** Minimal provider presets for the first-run terminal setup. Mirrors the
 * built-in presets the web LLM Configuration modal offers. The backend provider
 * is OpenAI-compatible, so each entry just needs a base URL + a default model. */
export type ProviderPreset = {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /** Local providers (e.g. Ollama) need no API key. */
  needsKey: boolean;
};

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek',   label: 'DeepSeek',   baseUrl: 'https://api.deepseek.com/v1',   defaultModel: 'deepseek-chat',                 needsKey: true },
  { id: 'openai',     label: 'OpenAI',     baseUrl: 'https://api.openai.com/v1',     defaultModel: 'gpt-4o-mini',                   needsKey: true },
  { id: 'groq',       label: 'Groq',       baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.1-8b-instant',         needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',  defaultModel: 'google/gemini-2.0-flash-001',   needsKey: true },
  { id: 'ollama',     label: 'Ollama',     baseUrl: 'http://localhost:11434/v1',     defaultModel: 'qwen2.5-coder',                 needsKey: false },
];

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(p => p.id === id.toLowerCase());
}
