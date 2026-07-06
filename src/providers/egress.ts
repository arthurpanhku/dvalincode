import { checkEgress, permissivePolicy, PolicyViolationError } from '../core/policy.js';
import type { ChatRequest } from './types.js';

const MAX_REDIRECTS = 5;

export async function governedProviderFetch(
  target: string,
  init: RequestInit,
  request: ChatRequest,
  provider: string,
  configuredBaseUrl: string,
  model: string,
): Promise<Response> {
  const policy = request.runtime?.policy ?? permissivePolicy();
  const audit = request.runtime?.audit;
  const configuredOrigin = parseOrigin(configuredBaseUrl);
  let current = new URL(target);
  let currentInit = { ...init, redirect: 'manual' as const };
  const started = Date.now();

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const isConfiguredEndpoint = current.origin === configuredOrigin;
    const decision = checkEgress(policy, isConfiguredEndpoint);
    if (!decision.allowed) {
      audit?.append({
        type: 'provider_request',
        provider,
        model,
        origin: current.origin,
        outcome: 'blocked',
        durationMs: Date.now() - started,
      });
      audit?.append({
        type: 'policy_violation',
        rule: decision.rule,
        tool: 'provider',
        target: current.origin,
      });
      throw new PolicyViolationError('provider', decision.rule, current.origin);
    }
    assertProviderUrlAllowed(current, configuredOrigin);

    let response: Response;
    try {
      // Provider endpoints are validated before each request and redirect.
      response = await fetch(current, currentInit);
    } catch (error) {
      audit?.append({
        type: 'provider_request',
        provider,
        model,
        origin: current.origin,
        outcome: 'error',
        durationMs: Date.now() - started,
      });
      throw error;
    }

    if (!isRedirect(response.status)) {
      audit?.append({
        type: 'provider_request',
        provider,
        model,
        origin: current.origin,
        outcome: response.ok ? 'ok' : 'error',
        durationMs: Date.now() - started,
        statusCode: response.status,
      });
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      audit?.append({
        type: 'provider_request',
        provider,
        model,
        origin: current.origin,
        outcome: 'error',
        durationMs: Date.now() - started,
        statusCode: response.status,
      });
      throw new Error(`Provider redirect ${response.status} did not include a Location header`);
    }
    if (redirects === MAX_REDIRECTS) {
      throw new Error(`Provider exceeded ${MAX_REDIRECTS} redirects`);
    }

    const next = new URL(location, current);
    await response.body?.cancel().catch(() => undefined);
    currentInit = redirectInit(response.status, currentInit, current, next);
    current = next;
  }

  throw new Error('Provider redirect handling failed');
}

function parseOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`Invalid provider base URL: ${value}`);
  }
}

function assertProviderUrlAllowed(url: URL, configuredOrigin: string): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Blocked provider URL: unsupported protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Blocked provider URL: embedded credentials are not allowed');
  }

  const scope = classifyHost(url.hostname);
  if (scope === 'public') return;
  if (scope === 'loopback' && url.origin === configuredOrigin) return;
  if (allowPrivateProviderUrls() && url.origin === configuredOrigin) return;

  throw new Error(`Blocked provider URL: ${url.origin} targets a restricted network address`);
}

function allowPrivateProviderUrls(): boolean {
  const value = process.env.DVALINCODE_ALLOW_PRIVATE_PROVIDER_URLS?.toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function classifyHost(hostname: string): 'public' | 'loopback' | 'private' {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!host) return 'private';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return 'loopback';
    if (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    ) {
      return 'private';
    }
    return 'public';
  }

  if (host === '::1') return 'loopback';
  if (host === '::' || host.startsWith('fc') || host.startsWith('fd')) return 'private';
  if (/^fe[89ab][0-9a-f]*:/i.test(host)) return 'private';
  return 'public';
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map(part => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : Number.NaN;
  });
  if (octets.some(Number.isNaN)) return null;
  return octets as [number, number, number, number];
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function redirectInit(
  status: number,
  init: RequestInit & { redirect: 'manual' },
  previous: URL,
  next: URL,
): RequestInit & { redirect: 'manual' } {
  const headers = new Headers(init.headers);
  if (previous.origin !== next.origin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
  }
  if (status === 303 || ((status === 301 || status === 302) && init.method?.toUpperCase() === 'POST')) {
    headers.delete('content-length');
    headers.delete('content-type');
    return { ...init, method: 'GET', body: undefined, headers };
  }
  return { ...init, headers };
}
