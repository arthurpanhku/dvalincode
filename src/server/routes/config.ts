import { Router } from 'express';
import { readConfig, writeConfig, maskConfig } from '../configStore.js';
import type { LLMConfig, Profile, ProviderPoolConfig } from '../configStore.js';
import { resetRRCursor } from '../../providers/pool.js';
import { createOpenAICompatibleProvider } from '../../providers/openaiCompatible.js';
import { resolveApiKey } from '../../providers/secrets.js';
import { requireTrustedProviderBaseUrl } from '../../providers/trustedBaseUrls.js';

export const configRouter = Router();

function persistableApiKey(
  incoming: { apiKey?: string; keySource?: string },
  existing?: { apiKey?: string },
): string | undefined {
  if (incoming.keySource === 'env' || incoming.keySource === 'gateway') {
    return undefined;
  }
  if (incoming.apiKey === '••••••••' || incoming.apiKey === undefined) {
    return existing?.apiKey;
  }
  return incoming.apiKey || undefined;
}

// Profile routes must be registered before the root route to avoid being shadowed

configRouter.get('/profiles', async (_req, res) => {
  const config = await readConfig();
  const profiles = config.profiles ?? {};
  // Mask apiKey in each profile
  const masked = Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => [
      name,
      { ...profile, apiKey: profile.apiKey ? '••••••••' : undefined },
    ]),
  );
  res.json(masked);
});

configRouter.post('/profiles/:name', async (req, res) => {
  const { name } = req.params;
  const body = req.body as Partial<Profile>;
  if (!body.provider) {
    res.status(400).json({ error: 'Missing required field: provider' });
    return;
  }

  const config = await readConfig();
  const profiles = config.profiles ?? {};
  const existingSecret = profiles[name] ?? (body.provider === config.llm.provider ? config.llm : undefined);
  profiles[name] = {
    provider: body.provider,
    apiKey: persistableApiKey(body, existingSecret),
    keySource: body.keySource,
    apiKeyEnv: body.apiKeyEnv || undefined,
    baseUrl: body.baseUrl || undefined,
    model: body.model || undefined,
  };
  const updated = { ...config, profiles };
  await writeConfig(updated);
  res.json({ name, profile: { ...profiles[name], apiKey: profiles[name].apiKey ? '••••••••' : undefined } });
});

configRouter.delete('/profiles/:name', async (req, res) => {
  const { name } = req.params;
  const config = await readConfig();
  const profiles = config.profiles ?? {};
  if (!profiles[name]) {
    res.status(404).json({ error: `Profile "${name}" not found` });
    return;
  }
  delete profiles[name];
  const updated = { ...config, profiles };
  await writeConfig(updated);
  res.json({ deleted: name });
});

configRouter.post('/profiles/:name/apply', async (req, res) => {
  const { name } = req.params;
  const config = await readConfig();
  const profiles = config.profiles ?? {};
  const profile = profiles[name];
  if (!profile) {
    res.status(404).json({ error: `Profile "${name}" not found` });
    return;
  }
  const updated = {
    ...config,
    llm: {
      provider: profile.provider,
      apiKey: profile.apiKey,
      keySource: profile.keySource,
      apiKeyEnv: profile.apiKeyEnv,
      baseUrl: profile.baseUrl,
      model: profile.model,
    },
  };
  await writeConfig(updated);
  res.json(maskConfig(updated));
});

configRouter.get('/', async (_req, res) => {
  const config = await readConfig();
  res.json(maskConfig(config));
});

configRouter.post('/test', async (req, res) => {
  const body = req.body as { llm?: Partial<LLMConfig> };
  if (!body.llm) {
    res.status(400).json({ ok: false, error: 'Missing llm config' });
    return;
  }

  const current = await readConfig();
  const candidate: LLMConfig = {
    ...current.llm,
    ...body.llm,
    apiKey: persistableApiKey(body.llm, current.llm),
  };

  if (!candidate.provider) {
    res.status(400).json({ ok: false, error: 'Provider is required' });
    return;
  }
  if (!candidate.model) {
    res.status(400).json({ ok: false, error: 'Model is required' });
    return;
  }

  const started = Date.now();
  try {
    const baseUrl = requireTrustedProviderBaseUrl(candidate.provider, candidate.baseUrl);
    const provider = createOpenAICompatibleProvider({
      name: candidate.provider,
      apiKey: resolveApiKey(candidate),
      baseUrl,
      model: candidate.model,
    });
    await provider.chat({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      maxTokens: 8,
      temperature: 0,
    });
    res.json({ ok: true, provider: candidate.provider, model: candidate.model, latencyMs: Date.now() - started });
  } catch (err) {
    res.status(400).json({
      ok: false,
      provider: candidate.provider,
      model: candidate.model,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

configRouter.post('/', async (req, res) => {
  const body = req.body as { llm?: Partial<LLMConfig> };
  if (!body.llm) {
    res.status(400).json({ error: 'Missing llm config' });
    return;
  }

  const current = await readConfig();

  const updated = {
    ...current,
    llm: {
      ...current.llm,
      ...body.llm,
      apiKey: persistableApiKey(body.llm, current.llm),
    },
  };

  await writeConfig(updated);
  res.json(maskConfig(updated));
});

// ── Provider pool ─────────────────────────────────────────────────────────────

configRouter.get('/pool', async (_req, res) => {
  const config = await readConfig();
  const masked = maskConfig(config);
  res.json(masked.pool ?? { enabled: false, policy: 'round-robin', entries: [] });
});

configRouter.post('/pool', async (req, res) => {
  const body = req.body as Partial<ProviderPoolConfig>;
  if (!body || typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'Invalid pool config' });
    return;
  }

  const current = await readConfig();
  const existingEntries = current.pool?.entries ?? [];

  // Preserve real API keys where the browser sent the mask placeholder
  const entries = (body.entries ?? []).map(incoming => {
    const existing = existingEntries.find(e => e.id === incoming.id);
    return { ...incoming, apiKey: persistableApiKey(incoming, existing) };
  });

  const updated: typeof current = {
    ...current,
    pool: {
      enabled: body.enabled,
      policy: body.policy ?? 'round-robin',
      entries,
    },
  };

  await writeConfig(updated);
  resetRRCursor();
  res.json(maskConfig(updated).pool);
});
