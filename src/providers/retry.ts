import type { ChatRequest, ChatResponse, RetryOptions } from './types.js';

/**
 * Transient provider failures -- a rate limit, an overloaded API, a dropped
 * connection -- are retried with backoff instead of ending the turn. Every
 * attempt is its own `governedProviderFetch` call, so the egress check and the
 * `provider_request` audit record apply to each try; nothing here touches the
 * network itself.
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Timeout, rate limit, server error, and Anthropic's 529 overload. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

const RETRYABLE_STREAM_ERROR = /overloaded|rate.?limit|server.?error|api_error|timeout|unavailable/i;

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** The provider answered with a non-2xx status. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Provider API error ${status}: ${body}`);
    this.name = 'ProviderHttpError';
  }
}

/** The provider reported an error, or stopped early, inside a stream that had started. */
export class ProviderStreamError extends Error {
  constructor(
    readonly errorType: string,
    detail: string,
    readonly retryable: boolean,
  ) {
    super(`Provider stream error (${errorType}): ${detail}`);
    this.name = 'ProviderStreamError';
  }
}

/** The error for an `error` payload found inside an event stream. */
export function providerStreamError(error: unknown): ProviderStreamError {
  const detail = (error && typeof error === 'object' ? error : {}) as { type?: unknown; code?: unknown; message?: unknown };
  const type = String(detail.type ?? detail.code ?? 'error');
  const message = typeof detail.message === 'string' ? detail.message : JSON.stringify(error);
  return new ProviderStreamError(type, message, RETRYABLE_STREAM_ERROR.test(`${type} ${String(detail.code ?? '')}`));
}

/** `retry-after-ms`, or `retry-after` in seconds or as an HTTP date. */
export function retryAfterMs(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const value = headers.get('retry-after');
  if (value === null) return undefined;
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const CONTEXT_OVERFLOW = /context.?length|context window|maximum context|prompt is too long|too many tokens|input is too long|reduce the length/i;

/** The provider refused the request because the prompt exceeds the model's context window. */
export function isContextOverflowError(err: unknown): boolean {
  return err instanceof ProviderHttpError && (err.status === 400 || err.status === 413) && CONTEXT_OVERFLOW.test(err.body);
}

export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) return RETRYABLE_STATUS.has(err.status);
  if (err instanceof ProviderStreamError) return err.retryable;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code ?? (err.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return NETWORK_ERROR_CODES.has(code);
  // undici reports a refused or dropped connection as `fetch failed` / `terminated`.
  return err instanceof TypeError && /fetch failed|terminated|network/i.test(err.message);
}

/**
 * Run `attempt`, retrying transient failures with jittered exponential backoff.
 * `canRetry` lets a streaming caller refuse once output has reached its consumer.
 */
export async function withProviderRetry<T>(
  attempt: () => Promise<T>,
  signal: AbortSignal | undefined,
  options: RetryOptions = {},
  canRetry: () => boolean = () => true,
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (err) {
      if (signal?.aborted || retry >= maxRetries || !canRetry() || !isRetryableProviderError(err)) throw err;
      await sleep(backoffMs(err, retry, options), signal);
    }
  }
}

/**
 * One adapter call with retries. A streamed call is retried only until its
 * first delta reaches the caller: after that a retry would repeat output the
 * caller has already shown.
 */
export function chatWithRetry(
  request: ChatRequest,
  once: (request: ChatRequest) => Promise<ChatResponse>,
  options?: RetryOptions,
): Promise<ChatResponse> {
  const onDelta = request.onDelta;
  if (!onDelta) return withProviderRetry(() => once(request), request.signal, options);
  let emitted = false;
  const tracked: ChatRequest = {
    ...request,
    onDelta: delta => {
      emitted = true;
      onDelta(delta);
    },
  };
  return withProviderRetry(() => once(tracked), request.signal, options, () => !emitted);
}

function backoffMs(err: unknown, retry: number, options: RetryOptions): number {
  const maxDelay = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const hinted = err instanceof ProviderHttpError ? err.retryAfterMs : undefined;
  if (hinted !== undefined) return Math.min(hinted, maxDelay);
  const exponential = Math.min(maxDelay, (options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS) * 2 ** retry);
  // Equal jitter, so runs that failed together do not all retry together.
  return exponential / 2 + Math.random() * (exponential / 2);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
