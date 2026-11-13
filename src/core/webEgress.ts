import dns from 'node:dns';
import { isIP } from 'node:net';
import type { DvalinContext } from './context.js';
import { checkEgress, PolicyViolationError } from './policy.js';
import { VERSION } from '../version.js';

/**
 * The one network path for the built-in web tools (web_search, web_fetch).
 *
 * Every request, and every redirect hop, is checked against org policy and
 * refused when its host is, or resolves to, a non-public address. Each hop is
 * audited by origin only: never the path, query, headers or body, which carry
 * search terms and API keys.
 *
 * The DNS check runs before connecting and fetch resolves the name again, so a
 * rebinding server could still swap addresses between the two lookups. The
 * check stops the common cases (localhost aliases, intranet names, cloud
 * metadata endpoints); it is not a network-level boundary.
 */

export const WEB_USER_AGENT = `Mozilla/5.0 (compatible; DvalinCode/${VERSION}; +https://dvalincode.dev)`;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type WebRequestOptions = {
  /** Tool making the request, for audit records and policy errors. */
  tool: string;
  context: DvalinContext;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Stop reading the body after this many bytes. */
  maxBytes: number;
  /** Refuse a response whose Content-Type fails this test, without reading its body. */
  acceptContentType?: (contentType: string) => boolean;
  timeoutMs?: number;
};

export type WebResponse =
  | { kind: 'response'; url: URL; status: number; contentType: string; text: string; bytes: number; truncated: boolean }
  /** A redirect to another host. It is returned rather than followed so the caller decides. */
  | { kind: 'redirect'; url: URL; status: number; location: URL };

/** Parse a URL the web tools may request: http(s) only, no embedded credentials. */
export function parseWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Only http and https URLs are supported, not ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  return url;
}

/**
 * Admission for one request target: org policy first, then the public-address
 * check. Both refusals are audited. Callers that ask a person before a request
 * run this first, so nobody is asked to approve a request that would be refused.
 */
export async function assertWebTargetAllowed(url: URL, tool: string, context: DvalinContext): Promise<void> {
  const decision = checkEgress(context.policy, false);
  if (!decision.allowed) {
    context.audit?.append({ type: 'web_request', tool, origin: url.origin, outcome: 'blocked', durationMs: 0 });
    context.audit?.append({ type: 'policy_violation', rule: decision.rule, tool, target: url.origin });
    throw new PolicyViolationError(tool, decision.rule, url.origin);
  }

  const started = Date.now();
  try {
    await assertPublicHost(url);
  } catch (error) {
    context.audit?.append({ type: 'web_request', tool, origin: url.origin, outcome: 'blocked', durationMs: Date.now() - started });
    throw error;
  }
}

/** Make one governed request, following redirects that stay on the same host. */
export async function governedWebRequest(target: string, options: WebRequestOptions): Promise<WebResponse> {
  const { tool, context } = options;
  let url = parseWebUrl(target);
  let method = options.method ?? 'GET';
  let body = options.body;

  for (let hop = 0; ; hop++) {
    await assertWebTargetAllowed(url, tool, context);

    const started = Date.now();
    let audited = false;
    const audit = (outcome: 'ok' | 'error', statusCode?: number): void => {
      audited = true;
      context.audit?.append({
        type: 'web_request',
        tool,
        origin: url.origin,
        outcome,
        durationMs: Date.now() - started,
        ...(statusCode === undefined ? {} : { statusCode }),
      });
    };

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    if (context.signal?.aborted) controller.abort();
    context.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers: options.headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        audit('ok', response.status);
        const location = response.headers.get('location');
        if (!location) throw new Error(`${url.origin} answered HTTP ${response.status} without a Location header`);
        const next = parseWebUrl(new URL(location, url).href);
        if (!sameSite(url, next)) return { kind: 'redirect', url, status: response.status, location: next };
        if (hop >= MAX_REDIRECTS) throw new Error(`Stopped after ${MAX_REDIRECTS} redirects at ${url.origin}`);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (options.acceptContentType && !options.acceptContentType(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        audit('error', response.status);
        throw new Error(`${url.href} is ${contentType.split(';')[0]}, which ${tool} cannot read as text`);
      }

      const { bytes, truncated } = await readCapped(response, options.maxBytes);
      audit(response.ok ? 'ok' : 'error', response.status);
      return {
        kind: 'response',
        url,
        status: response.status,
        contentType,
        text: decodeBody(bytes, contentType),
        bytes: bytes.byteLength,
        truncated,
      };
    } catch (error) {
      if (!audited) audit('error');
      if (timedOut) throw new Error(`${url.origin} did not respond within ${Math.round(timeoutMs / 1000)}s`);
      if (context.signal?.aborted) throw new Error('interrupted');
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * True for an address on the public internet. Loopback, private, link-local,
 * CGNAT (which includes Tailscale), multicast and reserved ranges are refused,
 * as are IPv6 forms that embed one of them (IPv4-mapped, NAT64, 6to4).
 *
 * 198.18.0.0/15 is allowed on purpose: proxy tools in fake-IP mode (Clash,
 * Surge) answer every DNS query from that range, and refusing it would break
 * web access for everyone behind one.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(ip);
  if (family === 4) return isPublicIpv4(ip.split('.').map(Number));
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast/reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT, Tailscale
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF assignments, TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

function isPublicIpv6(ip: string): boolean {
  const h = ipv6Hextets(ip);
  if (!h) return false;
  const embeddedIpv4 = (i: number): number[] => [h[i] >> 8, h[i] & 0xff, h[i + 1] >> 8, h[i + 1] & 0xff];
  if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) return isPublicIpv4(embeddedIpv4(6)); // IPv4-mapped
  if (h[0] === 0x64 && h[1] === 0xff9b) return isPublicIpv4(embeddedIpv4(6)); // NAT64
  if (h[0] === 0x2002) return isPublicIpv4(embeddedIpv4(1)); // 6to4
  if ((h[0] & 0xe000) !== 0x2000) return false; // outside global unicast: ::, ::1, fc00::/7, fe80::/10, ff00::/8
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) return false; // Teredo, documentation
  return true;
}

function ipv6Hextets(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const hextets = [...head, ...Array<string>(fill).fill('0'), ...tail].map(part => Number.parseInt(part, 16));
  return hextets.length === 8 && hextets.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? hextets : null;
}

async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  const refuse = (): Error =>
    new Error(
      `Blocked ${url.origin}: the web tools only reach public internet addresses, and this host is or resolves to a private, loopback, or link-local address.`,
    );

  if (host === 'localhost' || host.endsWith('.localhost')) throw refuse();
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw refuse();
    return;
  }

  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`Could not resolve ${host}${code ? ` (${code})` : ''}`);
  }
  if (records.length === 0 || records.some(record => !isPublicAddress(record.address))) throw refuse();
}

/** Same host, ignoring a leading "www." — the redirects a site makes to itself. */
function sameSite(a: URL, b: URL): boolean {
  const bare = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./, '');
  return bare(a) === bare(b);
}

async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks, total), truncated: false };
    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks, maxBytes), truncated: true };
    }
    chunks.push(value);
    total += value.byteLength;
  }
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const charset = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      // Bun types the label as a fixed union; any label works at runtime or throws.
      return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
    } catch {
      // Unknown label: fall back to UTF-8, which nearly every page uses anyway.
    }
  }
  return new TextDecoder().decode(bytes);
}
