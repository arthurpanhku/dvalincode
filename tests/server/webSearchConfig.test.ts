import { readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// configStore resolves its directory when first imported, so point it at a
// throwaway home before any import runs.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dvalin-web-search-config-'));
  process.env.DVALINCODE_HOME = dir;
  return dir;
});

const { configRouter } = await import('../../src/server/routes/config.js');
const { readConfig, writeConfig } = await import('../../src/server/configStore.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config`;
});

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
  delete process.env.DVALINCODE_HOME;
});

async function saveWebSearch(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/web-search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('web search key in Settings', () => {
  it('stores the key on disk but only ever returns it masked', async () => {
    await writeConfig({ llm: { provider: 'deepseek', apiKey: 'llm-key' } });

    const saved = await saveWebSearch({ provider: 'tavily', apiKey: ' tvly-secret ' });
    expect(saved).toEqual({ status: 200, json: { provider: 'tavily', apiKey: '••••••••', apiKeySet: true } });

    const onDisk = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(onDisk.webSearch).toEqual({ provider: 'tavily', apiKey: 'tvly-secret' });
    expect(onDisk.llm.apiKey).toBe('llm-key');

    const listed = await (await fetch(base)).text();
    expect(listed).not.toContain('tvly-secret');
    expect(JSON.parse(listed).webSearch).toEqual({ provider: 'tavily', apiKey: '••••••••', apiKeySet: true });
  });

  it('keeps the stored key when the mask comes back, and removes it on an empty key', async () => {
    await saveWebSearch({ provider: 'tavily', apiKey: 'tvly-secret' });

    await saveWebSearch({ provider: 'brave', apiKey: '••••••••' });
    expect((await readConfig()).webSearch).toEqual({ provider: 'brave', apiKey: 'tvly-secret' });

    const removed = await saveWebSearch({ provider: 'brave', apiKey: '' });
    expect(removed.json).toEqual({ provider: 'brave', apiKeySet: false });
    expect((await readConfig()).webSearch).toBeUndefined();
  });

  it('rejects an unknown provider or a missing key', async () => {
    expect((await saveWebSearch({ provider: 'google', apiKey: 'x' })).status).toBe(400);
    expect((await saveWebSearch({ provider: 'tavily' })).status).toBe(400);
  });
});
