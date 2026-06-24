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

    let response: Response;
    try {
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
