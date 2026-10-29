import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AuditSink, readRecords } from '../src/audit/log.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { ProviderHttpError, ProviderStreamError, retryAfterMs } from '../src/providers/retry.js';

// Zero backoff keeps the suite fast; the delays themselves are not under test.
const fast = { baseDelayMs: 0 };
const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function completion(content: string): Response {
  return json({ choices: [{ message: { content } }], model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } });
}

function sse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function event(payload: Record<string, unknown>): string {
  return `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const messageStart = event({ type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 3 } } });
const blockStart = event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const textDelta = (text: string) => event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const finished = [
  event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  event({ type: 'message_stop' }),
];
const overloaded = event({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });

function openai() {
  return createOpenAICompatibleProvider({ apiKey: 'k', baseUrl: 'https://api.example.com/v1', model: 'm', retry: fast });
}

function anthropic() {
  return createAnthropicProvider({ apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-test', retry: fast });
}

describe('provider retries', () => {
  it('retries a rate-limited request and audits every attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'slow down' }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(completion('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-retry-'));
    const audit = new AuditSink('run_retry', dir);

    const response = await openai().chat({ ...ask, runtime: { audit } });

    expect(response.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Each try went through the governed fetch, so each one is on the record.
    const statuses = readRecords('run_retry', dir).flatMap(r => (r.type === 'provider_request' ? [r.statusCode] : []));
    expect(statuses).toEqual([429, 200]);
  });

  it('retries a connection that failed before any response', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))
      .mockResolvedValueOnce(completion('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openai().chat(ask)).resolves.toMatchObject({ content: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a request the provider rejected as invalid', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ error: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openai().chat(ask)).rejects.toMatchObject({ name: 'ProviderHttpError', status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and surfaces the last error', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ error: 'unavailable' }, 503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openai().chat(ask)).rejects.toBeInstanceOf(ProviderHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('stops waiting as soon as the run is interrupted', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({ error: 'busy' }, 503, { 'retry-after': '30' }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();

    await expect(openai().chat({ ...ask, signal: controller.signal })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries an OpenAI-compatible stream whose first chunk is an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse(['data: {"error":{"message":"overloaded","type":"server_error"}}\n\n']))
      .mockResolvedValueOnce(sse([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(openai().chat({ ...ask, onDelta: () => {} })).resolves.toMatchObject({ content: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an overloaded Anthropic stream that failed before any text reached the caller', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([messageStart, overloaded]))
      .mockResolvedValueOnce(sse([messageStart, blockStart, textDelta('hello'), ...finished]));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];

    const response = await anthropic().chat({ ...ask, onDelta: delta => deltas.push(delta) });

    expect(response.content).toBe('hello');
    expect(deltas).toEqual(['hello']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails instead of retrying once streamed text has reached the caller', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => sse([messageStart, blockStart, textDelta('partial'), overloaded]));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];

    // A retry would show "partial" twice. Before this, the error event was
    // ignored and the half reply came back looking complete.
    await expect(anthropic().chat({ ...ask, onDelta: delta => deltas.push(delta) }))
      .rejects.toBeInstanceOf(ProviderStreamError);
    expect(deltas).toEqual(['partial']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an Anthropic stream that ends before message_stop as incomplete', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([messageStart, blockStart]))
      .mockResolvedValueOnce(sse([messageStart, blockStart, textDelta('whole'), ...finished]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(anthropic().chat({ ...ask, onDelta: () => {} })).resolves.toMatchObject({ content: 'whole' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads retry-after hints in milliseconds, seconds, or as a date', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '150' }))).toBe(150);
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2_000);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() + 5_000).toUTCString() }))).toBeGreaterThan(3_000);
    expect(retryAfterMs(new Headers())).toBeUndefined();
  });
});
