import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODE_TOOLS } from '../src/agent/modes.js';
import type { AuditEvent, AuditSink } from '../src/audit/log.js';
import { createDvalinContext, type DvalinContextOptions } from '../src/core/context.js';
import { PolicyViolationError, resolvePolicy } from '../src/core/policy.js';
import { isPublicAddress } from '../src/core/webEgress.js';
import type { AppConfig } from '../src/server/configStore.js';
import { htmlToText, inlineHtmlToText } from '../src/tools/htmlText.js';
import { AgentRunner } from '../src/agent/runner.js';
import { createDefaultToolRegistry, ToolRegistry } from '../src/tools/registry.js';
import { webFetchTool } from '../src/tools/webFetch.js';
import { NO_SEARCH_KEY_MESSAGE, selectSearchBackend, webSearchTool } from '../src/tools/webSearch.js';

// The saved config web_search reads, so no test touches ~/.dvalincode.
const savedConfig = vi.hoisted(() => ({ current: { llm: { provider: 'deepseek' } } as AppConfig }));
vi.mock('../src/server/configStore.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/server/configStore.js')>()),
  readConfig: async () => savedConfig.current,
}));

function recorder() {
  const events: AuditEvent[] = [];
  const sink = { append: (event: AuditEvent) => events.push(event) } as unknown as AuditSink;
  return { sink, events };
}

function context(options: DvalinContextOptions = {}) {
  return createDvalinContext({ cwd: process.cwd(), approvalMode: 'bypass', ...options });
}

function textResponse(body: string, contentType = 'text/plain; charset=utf-8', status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function tavilyAnswer(results: Array<{ title: string; url: string; content: string }>): Response {
  return textResponse(JSON.stringify({ results }), 'application/json');
}

beforeEach(() => {
  // Every host resolves to a public address unless a test says otherwise.
  vi.spyOn(dns.promises, 'lookup').mockResolvedValue([{ address: '93.184.215.14', family: 4 }] as never);
  // No search key from the developer's own shell or config leaks into a test.
  vi.stubEnv('TAVILY_API_KEY', '');
  vi.stubEnv('BRAVE_API_KEY', '');
  vi.stubEnv('DVALINCODE_SEARXNG_URL', '');
  savedConfig.current = { llm: { provider: 'deepseek' } };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('web tool registration', () => {
  it('registers web_search and web_fetch as read tools available in Chat and Plan', () => {
    const tools = createDefaultToolRegistry().list();
    for (const name of ['web_search', 'web_fetch']) {
      expect(tools.find(tool => tool.name === name)?.access).toBe('read');
      expect(MODE_TOOLS.chat).toContain(name);
    }
  });
});

describe('isPublicAddress', () => {
  it('accepts public addresses, including fake-IP proxy answers', () => {
    for (const ip of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '198.18.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
  });

  it('refuses loopback, private, link-local, CGNAT and embedded forms of them', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.100.100.100', '0.0.0.0',
      '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe',
      '2002:c0a8:101::1', '[::1]', 'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('htmlToText', () => {
  it('keeps headings, links, and code while dropping scripts and navigation', () => {
    const page = htmlToText(
      `<html><head><title>Example &amp; Docs</title><script>tracking()</script></head><body>
        <nav><a href="/">Home</a></nav>
        <main>
          <h1>Install <a href="#install">#</a></h1>
          <h2>Overview <a class="header-anchor" href="#overview">&#8203;</a></h2>
          <p>Wrap it in a &lt;div&gt; and see the
             <a href="/api?a=1&amp;b=2">API reference</a>.</p>
          <ul><li>one</li><li>two</li></ul>
          <pre><code>npm install x
  --save</code></pre>
        </main>
        <footer>© footer</footer>
      </body></html>`,
      'https://docs.example.com/guide',
    );

    expect(page.title).toBe('Example & Docs');
    expect(page.text).toContain('# Install');
    expect(page.text).toMatch(/^## Overview$/m);
    expect(page.text).toContain('Wrap it in a <div> and see the [API reference](https://docs.example.com/api?a=1&b=2).');
    expect(page.text).toContain('- one\n- two');
    expect(page.text).toContain('```\nnpm install x\n  --save\n```');
    expect(page.text).not.toMatch(/tracking|Home|footer/);
  });

  it('leaves no tag behind when one is split around another', () => {
    expect(inlineHtmlToText('<scr<script>x</script>ipt>alert(1)')).toBe('xipt>alert(1)');
    expect(htmlToText('<body><p><scr<b>ipt>alert(1)</p></body>', 'https://x.test/').text).not.toContain('<script');
  });

  it('decodes entities once and does not mistake custom elements for dropped ones', () => {
    const page = htmlToText('<body><p>a &amp;lt; b</p><nav-menu>kept</nav-menu><nav>dropped</nav></body>', 'https://x.test/');
    expect(page.text).toContain('a &lt; b');
    expect(page.text).toContain('kept');
    expect(page.text).not.toContain('dropped');
  });
});

describe('web_fetch', () => {
  it('returns page text labelled as untrusted, with the audit trail holding the origin only', async () => {
    const audit = recorder();
    const fetchMock = vi.fn(async () =>
      textResponse('<html><head><title>Guide</title></head><body><p>Hello <b>web</b></p></body></html>', 'text/html'),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await webFetchTool.run({ url: 'https://docs.example.com/guide?token=secret' }, context({ audit: audit.sink }));

    expect(result.output).toContain('Title: Guide');
    expect(result.output).toContain('URL: https://docs.example.com/guide?token=secret');
    expect(result.output).toContain('untrusted');
    expect(result.output).toContain('Hello web');
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'web_request', tool: 'web_fetch', origin: 'https://docs.example.com', outcome: 'ok', statusCode: 200 }),
    );
    expect(JSON.stringify(audit.events)).not.toContain('secret');
  });

  it('asks once per host per turn', async () => {
    const audit = recorder();
    const requestApproval = vi.fn(async () => true);
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('ok')));
    const turn = context({ approvalMode: 'full-auto', requestApproval, audit: audit.sink });

    await webFetchTool.run({ url: 'https://a.example.com/one' }, turn);
    await webFetchTool.run({ url: 'https://a.example.com/two' }, turn);
    await webFetchTool.run({ url: 'https://b.example.com/' }, turn);

    expect(requestApproval).toHaveBeenCalledTimes(2);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.stringMatching(/^apv_web_/),
      'web_fetch',
      expect.objectContaining({ url: 'https://a.example.com/one', host: 'a.example.com' }),
    );
    expect(audit.events.filter(event => event.type === 'approval')).toHaveLength(2);

    // A new turn is a new context, so it asks again.
    await webFetchTool.run({ url: 'https://a.example.com/one' }, context({ approvalMode: 'full-auto', requestApproval }));
    expect(requestApproval).toHaveBeenCalledTimes(3);
  });

  it('asks once per host for a whole agent turn, including when the turn has an abort signal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('ok')));
    const requestApproval = vi.fn(async () => true);
    const registry = new ToolRegistry();
    registry.register(webFetchTool);
    const replies = [
      '@tool("web_fetch", {"url": "https://docs.example.com/a"})',
      '@tool("web_fetch", {"url": "https://docs.example.com/b"})',
      'Done.',
    ];
    let reply = 0;
    const runner = new AgentRunner({
      provider: { name: 'scripted', chat: async () => ({ content: replies[Math.min(reply++, replies.length - 1)], model: 'scripted' }) },
      registry,
      context: context({ approvalMode: 'full-auto', requestApproval }),
      config: { maxIterations: 6, maxToolCallsPerTurn: 100, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: 'Work.',
    });

    await runner.runTurn('read the docs', [], undefined, new AbortController().signal);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('does not connect when the person declines or there is no one to ask', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      webFetchTool.run({ url: 'https://a.example.com/' }, context({ approvalMode: 'auto-edit', requestApproval: async () => false })),
    ).rejects.toThrow(/rejected/);
    await expect(webFetchTool.run({ url: 'https://a.example.com/' }, context({ approvalMode: 'full-auto' }))).rejects.toThrow(
      /no way to ask/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks private and non-http targets before asking or connecting', async () => {
    const audit = recorder();
    const fetchMock = vi.fn();
    const requestApproval = vi.fn(async () => true);
    vi.stubGlobal('fetch', fetchMock);
    const turn = context({ approvalMode: 'full-auto', requestApproval, audit: audit.sink });

    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://localhost:3000/', 'http://[::ffff:127.0.0.1]/']) {
      await expect(webFetchTool.run({ url }, turn), url).rejects.toThrow(/Blocked/);
    }
    vi.mocked(dns.promises.lookup).mockResolvedValueOnce([{ address: '10.0.0.8', family: 4 }] as never);
    await expect(webFetchTool.run({ url: 'http://intranet.corp/' }, turn)).rejects.toThrow(/Blocked/);
    await expect(webFetchTool.run({ url: 'file:///etc/passwd' }, turn)).rejects.toThrow(/Only http and https/);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'web_request', outcome: 'blocked' }));
  });

  it('follows same-host redirects and hands cross-host ones back to the model', async () => {
    const audit = recorder();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(redirect(301, 'https://www.example.com/b'))
      .mockResolvedValueOnce(textResponse('final page'))
      .mockResolvedValueOnce(redirect(302, 'https://elsewhere.example.net/x'));
    vi.stubGlobal('fetch', fetchMock);
    const turn = context({ audit: audit.sink });

    const followed = await webFetchTool.run({ url: 'http://example.com/a' }, turn);
    expect(followed.output).toContain('final page');
    expect(followed.output).toContain('URL: https://www.example.com/b');
    expect(audit.events.filter(event => event.type === 'web_request').map(event => event.origin)).toEqual([
      'http://example.com',
      'https://www.example.com',
    ]);

    const handedBack = await webFetchTool.run({ url: 'https://example.com/c' }, turn);
    expect(handedBack.output).toContain('https://elsewhere.example.net/x');
    expect(handedBack.output).toContain('Call web_fetch with that URL');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('refuses binary content and reports HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(textResponse('%PDF', 'application/pdf')).mockResolvedValueOnce(textResponse('nope', 'text/html', 404)),
    );
    await expect(webFetchTool.run({ url: 'https://example.com/file.pdf' }, context())).rejects.toThrow(/application\/pdf/);
    await expect(webFetchTool.run({ url: 'https://example.com/missing' }, context())).rejects.toThrow(/HTTP 404/);
  });

  it('stops reading at the size cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('a'.repeat(5_100_000))));
    const result = await webFetchTool.run({ url: 'https://example.com/huge.txt' }, context());
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.bytes).toBe(5_000_000);
    expect(result.output).toContain('Stopped after the first 5 MB');
  });

  it('reports an interrupted turn as interrupted', async () => {
    const abort = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
      ),
    );
    const pending = webFetchTool.run({ url: 'https://example.com/slow' }, context({ signal: abort.signal }));
    setTimeout(() => abort.abort(), 10);
    await expect(pending).rejects.toThrow('interrupted');
  });
});

describe('network policy', () => {
  it('blocks both web tools under network: endpoint-only and records the violation', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test-key');
    const audit = recorder();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const turn = context({ audit: audit.sink, policy: resolvePolicy([{ network: 'endpoint-only' }]) });

    await expect(webFetchTool.run({ url: 'https://example.com/' }, turn)).rejects.toBeInstanceOf(PolicyViolationError);
    await expect(webSearchTool.run({ query: 'vitest', maxResults: 5 }, turn)).rejects.toBeInstanceOf(PolicyViolationError);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'policy_violation', tool: 'web_fetch' }));
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'policy_violation', tool: 'web_search' }));
  });
});

describe('web_search', () => {
  it('fails with setup instructions, without any request, when no key is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(webSearchTool.run({ query: 'vitest', maxResults: 5 }, context())).rejects.toThrow(NO_SEARCH_KEY_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers the key saved in Settings, then TAVILY_API_KEY, then BRAVE_API_KEY', () => {
    expect(selectSearchBackend(undefined, {})).toBeNull();
    expect(selectSearchBackend(undefined, { TAVILY_API_KEY: '  ' })).toBeNull();
    expect(selectSearchBackend(undefined, { BRAVE_API_KEY: 'b' })?.name).toBe('brave');
    expect(selectSearchBackend(undefined, { TAVILY_API_KEY: 't', BRAVE_API_KEY: 'b' })?.name).toBe('tavily');
    expect(selectSearchBackend({ provider: 'brave', apiKey: 'saved' }, { TAVILY_API_KEY: 't' })?.name).toBe('brave');
    expect(selectSearchBackend({ provider: 'tavily' }, { BRAVE_API_KEY: 'b' })?.name).toBe('brave');
  });

  it('calls Tavily with the saved key and keeps the query and key out of the audit trail', async () => {
    savedConfig.current = { llm: { provider: 'deepseek' }, webSearch: { provider: 'tavily', apiKey: 'tvly-saved-key' } };
    const audit = recorder();
    const fetchMock = vi.fn(async () =>
      tavilyAnswer([
        { title: 'Tavily hit', url: 'https://example.org/t', content: 'plain  text <kept>' },
        { title: 'Second', url: 'https://example.org/2', content: 'more' },
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.run({ query: 'node private-term', maxResults: 1 }, context({ audit: audit.sink }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://api.tavily.com/search');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tvly-saved-key');
    expect(JSON.parse(String(init.body))).toEqual({ query: 'node private-term', max_results: 1 });
    expect(result.output).toContain('untrusted');
    expect(result.output).toContain('1. Tavily hit\n   https://example.org/t\n   plain text <kept>');
    expect(result.output).not.toContain('2.');
    expect(result.metadata).toEqual({ backend: 'tavily', results: 1 });
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'web_request', tool: 'web_search', origin: 'https://api.tavily.com', outcome: 'ok' }),
    );
    const trail = JSON.stringify(audit.events);
    expect(trail).not.toContain('private-term');
    expect(trail).not.toContain('tvly-saved-key');
  });

  it('calls Brave with a subscription token and strips its highlight markup', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'brave-test-key');
    const fetchMock = vi.fn(async () =>
      textResponse(
        JSON.stringify({ web: { results: [{ title: 'Brave hit', url: 'https://example.org/b', description: 'a <strong>bold</strong> claim' }] } }),
        'application/json',
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await webSearchTool.run({ query: 'node release', maxResults: 2 }, context());

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://api.search.brave.com/res/v1/web/search?q=node+release&count=2');
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('brave-test-key');
    expect(result.output).toContain('a bold claim');
    expect(result.metadata?.backend).toBe('brave');
  });

  it('reports an empty result set plainly', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test-key');
    vi.stubGlobal('fetch', vi.fn(async () => tavilyAnswer([])));
    const result = await webSearchTool.run({ query: 'nothing here', maxResults: 5 }, context());
    expect(result.output).toBe('No results for "nothing here".');
  });

  it('turns a failed API call into an error naming the service', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-bad');
    vi.stubGlobal('fetch', vi.fn(async () => textResponse('{"detail":"invalid key"}', 'application/json', 401)));
    await expect(webSearchTool.run({ query: 'x', maxResults: 5 }, context())).rejects.toThrow(/^Tavily search failed with HTTP 401$/);
  });
});


describe('SearXNG web search', () => {
  it('uses the configured endpoint and exposes only origin in audit', async () => {
    vi.stubEnv('DVALINCODE_SEARXNG_URL', 'https://search.example.com/search');
    const fetch = vi.fn(async (_url: URL, _init?: RequestInit) =>
      tavilyAnswer([{ title: 'Result', url: 'https://docs.example/', content: 'Match' }]));
    vi.stubGlobal('fetch', fetch);
    const { sink, events } = recorder();
    const result = await webSearchTool.run({ query: 'private search phrase', maxResults: 1 }, context({ audit: sink }));
    expect(result).toMatchObject({ metadata: { backend: 'searxng', results: 1 } });
    expect(fetch.mock.calls[0][0].searchParams.get('format')).toBe('json');
    expect(fetch.mock.calls[0][0].searchParams.get('q')).toBe('private search phrase');
    expect(JSON.stringify(events)).not.toContain('private search phrase');
  });

  it('keeps SearXNG under the public address and org policy gates', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('DVALINCODE_SEARXNG_URL', 'https://127.0.0.1/search');
    await expect(webSearchTool.run({ query: 'query', maxResults: 1 }, context())).rejects.toThrow(/private, loopback/);
    vi.stubEnv('DVALINCODE_SEARXNG_URL', 'https://search.example.com/search');
    await expect(webSearchTool.run({ query: 'query', maxResults: 1 },
      context({ policy: resolvePolicy([{ network: 'endpoint-only' }]) }))).rejects.toThrow(PolicyViolationError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not follow a cross-origin redirect carrying a search credential', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'tvly-test');
    const fetch = vi.fn(async () => redirect(307, 'http://api.tavily.com/search'));
    vi.stubGlobal('fetch', fetch);
    await expect(webSearchTool.run({ query: 'query', maxResults: 1 }, context())).rejects.toThrow(/redirected/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
