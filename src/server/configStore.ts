import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export type LLMConfig = {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type Profile = {
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type RotationPolicy = 'round-robin' | 'random' | 'weighted-random';

export type PoolEntry = {
  id: string;
  provider: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  weight: number;
  enabled: boolean;
};

export type ProviderPoolConfig = {
  enabled: boolean;
  policy: RotationPolicy;
  entries: PoolEntry[];
};

/** A remote MCP server DvalinCode may connect to. Header values may contain
 * `${ENV}` placeholders resolved from the environment at connect time. */
export type McpServerConfig = {
  id: string;
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
};

export type McpConfig = { servers: McpServerConfig[] };

export type AppConfig = {
  llm: LLMConfig;
  profiles?: Record<string, Profile>;
  pool?: ProviderPoolConfig;
  mcp?: McpConfig;
};

const CONFIG_DIR = join(homedir(), '.dvalincode');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS: AppConfig = {
  llm: {
    provider: process.env['DVALINCODE_PROVIDER'] ?? 'deepseek',
    apiKey: process.env['DVALINCODE_API_KEY'],
    baseUrl: process.env['DVALINCODE_BASE_URL'],
    model: process.env['DVALINCODE_MODEL'],
  },
};

export async function readConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    // Merge with defaults (env vars are overridden by saved config)
    return {
      llm: { ...DEFAULTS.llm, ...parsed.llm },
      profiles: parsed.profiles,
      pool: parsed.pool,
      mcp: parsed.mcp,
    };
  } catch {
    return DEFAULTS;
  }
}

export async function writeConfig(config: AppConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Return config safe for the browser (API keys masked). */
export function maskConfig(config: AppConfig): AppConfig & { llm: { apiKeySet: boolean } } {
  const maskedProfiles: Record<string, Profile> | undefined = config.profiles
    ? Object.fromEntries(
        Object.entries(config.profiles).map(([name, profile]) => [
          name,
          { ...profile, apiKey: profile.apiKey ? '••••••••' : undefined },
        ]),
      )
    : undefined;

  const maskedPool: ProviderPoolConfig | undefined = config.pool
    ? {
        ...config.pool,
        entries: config.pool.entries.map(e => ({
          ...e,
          apiKey: e.apiKey ? '••••••••' : undefined,
        })),
      }
    : undefined;

  const maskedMcp: McpConfig | undefined = config.mcp
    ? {
        servers: config.mcp.servers.map(s => ({
          ...s,
          headers: s.headers
            ? Object.fromEntries(Object.keys(s.headers).map(k => [k, '••••••••']))
            : undefined,
        })),
      }
    : undefined;

  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: config.llm.apiKey ? '••••••••' : undefined,
      apiKeySet: !!config.llm.apiKey,
    },
    profiles: maskedProfiles,
    pool: maskedPool,
    mcp: maskedMcp,
  };
}
