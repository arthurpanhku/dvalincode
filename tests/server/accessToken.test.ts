import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { resolveAccessToken } from '../../src/server/auth.js';
import { startServer } from '../../src/server/index.js';

const TOKEN = 'test-access-token-0123456789abcdef';
const sessionsDir = mkdtempSync(path.join(tmpdir(), 'dvalin-access-token-'));

let base: string;
let port: number;
let close: () => Promise<void>;

beforeAll(async () => {
  process.env.DVALINCODE_SESSIONS_DIR = sessionsDir;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const started = await startServer({ host: '127.0.0.1', port: 0, open: false, token: TOKEN });
  ({ port, close } = started);
  base = `http://127.0.0.1:${port}`;
  expect(started.url).toBe(`http://localhost:${port}/?token=${TOKEN}`);
});

afterAll(async () => {
  await close();
  vi.restoreAllMocks();
  rmSync(sessionsDir, { recursive: true, force: true });
});

/** Opens /ws and reports the outcome: 'open', or the HTTP status the upgrade was refused with. */
function connect(headers: Record<string, string> = {}): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', reject);
  });
}

async function cookieFromUnlock(token: string): Promise<{ status: number; setCookie: string | null }> {
  const res = await fetch(`${base}/api/auth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return { status: res.status, setCookie: res.headers.get('set-cookie') };
}

describe('local access token', () => {
  it('refuses the API without the token', async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/config`)).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`, { headers: { Authorization: 'Bearer wrong-token-0123456789' } })).status).toBe(401);
  });

  it('accepts a script that sends the token as a Bearer header', async () => {
    const res = await fetch(`${base}/api/sessions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('trades the token for an HttpOnly, SameSite=Strict cookie named for the port', async () => {
    const wrong = await cookieFromUnlock('not-the-token-0123456789');
    expect(wrong.status).toBe(401);
    expect(wrong.setCookie).toBeNull();

    const right = await cookieFromUnlock(TOKEN);
    expect(right.status).toBe(204);
    expect(right.setCookie).toBe(`dvalincode_token_${port}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);

    const cookie = right.setCookie!.split(';')[0]!;
    expect((await fetch(`${base}/api/auth/session`)).status).toBe(401);
    expect((await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).status).toBe(204);
    expect((await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it('ignores a valid token presented under another server\'s cookie name', async () => {
    const cookie = `dvalincode_token_${port + 1}=${TOKEN}`;
    expect((await fetch(`${base}/api/sessions`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('refuses the WebSocket without the token and opens it with the cookie', async () => {
    expect(await connect()).toBe(401);
    expect(await connect({ Cookie: `dvalincode_token_${port}=wrong` })).toBe(401);
    expect(await connect({ Cookie: `dvalincode_token_${port}=${TOKEN}` })).toBe('open');
    // The cookie does not override the origin check.
    expect(await connect({ Cookie: `dvalincode_token_${port}=${TOKEN}`, Origin: 'https://evil.example' })).toBe(403);
  });
});

describe('resolveAccessToken', () => {
  it('mints a random URL-safe token when none is configured', () => {
    const a = resolveAccessToken(undefined);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveAccessToken('')).not.toBe(a);
  });

  it('rejects a configured token that is short or unsafe in a URL or shell', () => {
    expect(() => resolveAccessToken('short')).toThrow(/DVALINCODE_SERVER_TOKEN/);
    expect(() => resolveAccessToken('0123456789abcdef"; rm -rf ~')).toThrow(/DVALINCODE_SERVER_TOKEN/);
    expect(resolveAccessToken('my-fixed-token_0123456789')).toBe('my-fixed-token_0123456789');
  });
});
