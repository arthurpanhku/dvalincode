import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Local access token.
 *
 * The server drives an agent that edits files and runs commands, so it must
 * answer only the person who launched it — not another local process or OS user
 * that finds the port, and not the network when `serve --host 0.0.0.0` is used.
 * The Origin check alone cannot do that: clients other than browsers send no
 * Origin header at all.
 *
 * Each server start mints a token (or takes `DVALINCODE_SERVER_TOKEN`) and
 * requires it on every /api request and on the /ws upgrade. A browser brings it
 * once in the launch URL (`/?token=…`) and trades it for an HttpOnly cookie;
 * scripts send `Authorization: Bearer <token>`.
 */
export type AccessToken = { token: string; cookieName: string };

/** URL- and shell-safe, so the launch URL can be printed and opened as-is. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export function newAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Rejects a token from the environment that could not be used safely in the launch URL. */
export function resolveAccessToken(configured: string | undefined): string {
  if (!configured) return newAccessToken();
  if (!TOKEN_PATTERN.test(configured)) {
    throw new Error('DVALINCODE_SERVER_TOKEN must be 16–256 characters of A–Z, a–z, 0–9, "-" or "_".');
  }
  return configured;
}

/**
 * Browsers share cookies across every port of a host, so a desktop window and a
 * `serve` tab on the same machine would overwrite each other's cookie. The name
 * carries the port to keep them apart.
 */
export function accessCookieName(port: number): string {
  return `dvalincode_token_${port}`;
}

export function tokenMatches(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** True when the request carries this server's token, as a Bearer header or the session cookie. */
export function isAuthorized(req: IncomingMessage, access: AccessToken | undefined): boolean {
  if (!access) return false;
  const header = req.headers.authorization;
  const presented = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : cookieValue(req.headers.cookie, access.cookieName);
  return tokenMatches(access.token, presented);
}

/** HttpOnly keeps it from page scripts; SameSite=Strict keeps other sites from sending it. */
export function accessCookie(access: AccessToken): string {
  return `${access.cookieName}=${access.token}; Path=/; HttpOnly; SameSite=Strict`;
}
