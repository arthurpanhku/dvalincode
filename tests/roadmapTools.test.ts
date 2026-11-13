import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRunner } from '../src/agent/runner.js';
import { DEFAULT_TURN_CONFIG } from '../src/agent/types.js';
import { AuditSink, newRunId, readRecords } from '../src/audit/log.js';
import { startCheckpoint } from '../src/core/checkpoint.js';
import { createDvalinContext } from '../src/core/context.js';
import { resolvePolicy } from '../src/core/policy.js';
import { redactToolText } from '../src/core/redactSecrets.js';
import { chatImagesSchema } from '../src/providers/chatImages.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAICompatibleProvider } from '../src/providers/openaiCompatible.js';
import { budgetedProvider } from '../src/providers/runBudget.js';
import type { ChatMessage, ProviderAdapter } from '../src/providers/types.js';
import { parseCheckDiagnostics } from '../src/tools/checkDiagnostics.js';
import { createDefaultToolRegistry, ToolRegistry } from '../src/tools/registry.js';
import { createRollbackRegistry } from '../src/tools/rollbackRun.js';
import { registerMcpServers } from '../src/mcp/register.js';

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dvalin-roadmap-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

it('redacts both persisted and fresh tool messages before provider egress', async () => {
  const dir = await temp();
  const audit = new AuditSink(newRunId(), dir);
  const token = 'ghp_' + 'A'.repeat(36);
  const key = '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';
  const registry = new ToolRegistry();
  registry.register({ name: 'probe', description: '', access: 'read', inputSchema: z.object({}),
    run: async () => ({ title: 'test', output: key }) });
  const requests: string[] = [];
  const provider: ProviderAdapter = { name: 'test', chat: async request => {
    requests.push(JSON.stringify(request.messages));
    return { content: requests.length === 1 ? '@tool("probe", {})' : 'Finished.', model: 'test' };
  } };
  const history: ChatMessage[] = [{ role: 'tool', content: token }];
  await new AgentRunner({ provider, registry, context: createDvalinContext({ audit }), config: DEFAULT_TURN_CONFIG, systemPrompt: 'Test.' })
    .runTurn('go', history);
  expect(requests.join('')).not.toContain(token);
  expect(requests.join('')).not.toContain('BEGIN PRIVATE KEY');
  expect(readRecords(audit.runId, dir).filter(event => event.type === 'tool_redaction')).toHaveLength(2);
  expect(redactToolText('AWS_SECRET_ACCESS_KEY="abcdefghijklmnop"').count).toBe(1);
});

it('runs safe reads together while keeping writes behind them and tool responses ordered', async () => {
  const registry = new ToolRegistry();
  const events: string[] = [];
  let release: (() => void) | undefined;
  const first = new Promise<void>(resolve => { release = resolve; });
  for (const name of ['first', 'second', 'mutation', 'third']) {
    registry.register({
      name, description: '', access: name === 'mutation' ? 'write' : 'read', inputSchema: z.object({}),
      isConcurrencySafe: () => true,
      run: async () => {
        events.push(`start ${name}`);
        if (name === 'first') await first;
        if (name === 'second') release?.();
        events.push(`end ${name}`);
        return { title: name, output: name };
      },
    });
  }
  let calls = 0;
  const provider: ProviderAdapter = { name: 'test', chat: async () => ({
    model: 'test', content: calls++ ? 'Finished.' : ['first', 'second', 'mutation', 'third'].map(name => `@tool("${name}", {})`).join(' '),
  }) };
  const result = await new AgentRunner({ provider, registry, context: createDvalinContext({ approvalMode: 'full-auto' }),
    config: DEFAULT_TURN_CONFIG, systemPrompt: 'Test.' }).runTurn('go', []);
  expect(events).toEqual(['start first', 'start second', 'end second', 'end first', 'start mutation', 'end mutation', 'start third', 'end third']);
  expect(result.messages.filter(message => message.role === 'tool').map(message => message.name)).toEqual(['first', 'second', 'mutation', 'third']);
});

it('narrows token and cost ceilings and refuses a second request before egress', async () => {
  const chat = vi.fn(async () => ({ content: 'ok', model: 'test', usage: { inputTokens: 3, outputTokens: 2 } }));
  const policy = resolvePolicy([{ maxTokens: 15, maxCostUsd: 0.000020 }, { maxTokens: 10, maxCostUsd: 1 }]);
  expect(policy).toMatchObject({ maxTokens: 10, maxCostUsd: 0.000020 });
  const provider = budgetedProvider({ name: 'test', chat, budgetInputUpperBound: () => 5 }, policy, undefined, {
    DVALINCODE_BUDGET_INPUT_USD_PER_MILLION: '1', DVALINCODE_BUDGET_OUTPUT_USD_PER_MILLION: '1',
  });
  await provider.chat({ messages: [] });
  expect(chat).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 5, singleAttempt: true }));
  await expect(provider.chat({ messages: [] })).rejects.toThrow(/budget is too small/);
  expect(chat).toHaveBeenCalledTimes(1);
});

it('keeps questions available in bypass but requires an actual answer and minimizes audit', async () => {
  const dir = await temp();
  const audit = new AuditSink(newRunId(), dir);
  const registry = createDefaultToolRegistry();
  const input = { question: 'Which name?', options: ['first-private-label', 'second-private-label'] };
  const available = createDvalinContext({ approvalMode: 'bypass', askUser: async () => 1, audit });
  expect((await registry.run('ask_user', input, available)).output).toContain('second-private-label');
  expect((await registry.run('ask_user', input, createDvalinContext({ approvalMode: 'bypass' }))).output).toContain('cannot ask');
  expect(await readFile(audit.file, 'utf8')).not.toContain('private-label');
});

it('validates every patch before writing and refuses undo after intervening edits', async () => {
  const cwd = await temp();
  const registry = createDefaultToolRegistry();
  const a = path.join(cwd, 'a.txt');
  const b = path.join(cwd, 'b.txt');
  await writeFile(a, 'first');
  await writeFile(b, 'second');
  const files = [{ filePath: 'a.txt', oldString: 'first', newString: '' }, { filePath: 'b.txt', oldString: 'second', newString: 'updated' }];
  const ctx = createDvalinContext({ cwd, approvalMode: 'full-auto' });
  await expect(registry.run('apply_patch', { files: [files[0], { ...files[1], oldString: 'absent' }] }, ctx)).rejects.toThrow(/exactly one/);
  await expect(registry.run('apply_patch', { files }, { ...ctx, policy: resolvePolicy([{ paths: { deny: ['b.txt'] } }]) })).rejects.toThrow(/policy/);
  expect(await readFile(a, 'utf8')).toBe('first');
  const result = await registry.run('apply_patch', { files }, ctx);
  const reverse = registry.get('apply_patch')!.reverse!({ files }, result)!;
  await writeFile(b, 'user edit');
  await expect(registry.run(reverse.toolName, reverse.input, ctx)).rejects.toThrow(/changed since/);
  expect(await readFile(a, 'utf8')).toBe('');
  await writeFile(b, 'updated');
  await registry.run(reverse.toolName, reverse.input, ctx);
  expect(await readFile(a, 'utf8')).toBe('first');
  expect(await readFile(b, 'utf8')).toBe('second');
});

it('restores tracked and new files only after validating the post-run state', async () => {
  const cwd = await temp();
  vi.stubEnv('DVALINCODE_HOME', await temp());
  execFileSync('git', ['init', '-q'], { cwd });
  const tracked = path.join(cwd, 'tracked.txt');
  const added = path.join(cwd, 'new.txt');
  const deleted = path.join(cwd, 'removed', 'nested.txt');
  await mkdir(path.dirname(deleted));
  await writeFile(deleted, 'nested');
  await writeFile(tracked, 'original');
  execFileSync('git', ['add', 'tracked.txt', 'removed/nested.txt'], { cwd });
  const runId = newRunId();
  const finish = await startCheckpoint(cwd, runId, () => true);
  await writeFile(tracked, 'updated');
  await writeFile(added, 'created');
  await rm(path.dirname(deleted), { recursive: true });
  expect(await finish()).toEqual({ changed: 3 });

  const { registry } = await createRollbackRegistry(runId);
  const context = createDvalinContext({ cwd, approvalMode: 'full-auto' });
  await writeFile(tracked, 'user edit');
  await expect(registry.run('rollback_run', { runId }, context)).rejects.toThrow(/Rollback conflict/);
  expect(await readFile(added, 'utf8')).toBe('created');
  await writeFile(tracked, 'updated');
  await registry.run('rollback_run', { runId }, context);
  expect(await readFile(tracked, 'utf8')).toBe('original');
  await expect(readFile(added)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(deleted, 'utf8')).toBe('nested');
});

it('parses recognized diagnostic locations and excludes paths outside the project', () => {
  expect(parseCheckDiagnostics('src/app.ts(3,5): error TS2304: Missing name\n../external.ts:4: error\ntest/a.py:2: E failed', '/repo')).toEqual([
    { file: 'src/app.ts', line: 3, column: 5, message: 'TS2304: Missing name' },
    { file: 'test/a.py', line: 2, message: 'failed' },
  ]);
});

it('serializes native image blocks for the two providers and validates media type', async () => {
  const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' } as const;
  expect(chatImagesSchema.safeParse([png]).success).toBe(true);
  expect(chatImagesSchema.safeParse([{ ...png, mediaType: 'image/jpeg' }]).success).toBe(false);
  const fetch = vi.fn(async (_url, _init) => new Response(JSON.stringify({ model: 'test', choices: [], content: [] })));
  vi.stubGlobal('fetch', fetch);
  const request = { messages: [{ role: 'user' as const, content: 'inspect', images: [png] }] };
  await createOpenAICompatibleProvider({ model: 'gpt-4o' }).chat(request);
  await createAnthropicProvider({ model: 'claude-sonnet-4-6' }).chat(request);
  expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content[1]).toMatchObject({ type: 'image_url' });
  expect(JSON.parse(fetch.mock.calls[1][1].body).messages[0].content[1]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
});

it('anchors denied MCP discovery without making a request', async () => {
  const dir = await temp();
  const audit = new AuditSink(newRunId(), dir);
  const registry = new ToolRegistry();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await registerMcpServers(registry, [{ id: 'blocked', enabled: true, url: 'https://mcp.example/' }], {
    cwd: dir, policy: resolvePolicy([{ mcp: { allow: [] } }]), audit,
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(readRecords(audit.runId, dir)).toContainEqual(expect.objectContaining({ type: 'mcp_discovery', server: 'blocked', outcome: 'denied' }));
});

it('counts automatic diagnostics and hooks against the run tool budget', async () => {
  vi.stubEnv('DVALINCODE_PRE_TOOL_COMMAND', '');
  vi.stubEnv('DVALINCODE_POST_TOOL_COMMAND', 'formatter');
  vi.stubEnv('DVALINCODE_EDIT_DIAGNOSTICS', 'lint');
  const registry = new ToolRegistry();
  registry.register({ name: 'read_file', description: '', access: 'read', inputSchema: z.object({}),
    run: async () => ({ title: 'read', output: 'context' }) });
  registry.register({ name: 'write_file', description: '', access: 'write', inputSchema: z.object({ filePath: z.string() }),
    run: async () => ({ title: 'write', output: 'written', metadata: { path: 'a.ts' } }) });
  const check = vi.fn(async () => ({ title: 'check', output: '', metadata: { exitCode: 0 } }));
  registry.register({ name: 'run_check', description: '', access: 'execute',
    inputSchema: z.object({ kind: z.string(), command: z.string().optional(), timeoutMs: z.number() }), run: check });
  const provider: ProviderAdapter = { name: 'test', chat: async () => ({ model: 'test',
    content: '@tool("read_file", {}) @tool("write_file", {"filePath":"a.ts"})' }) };
  const result = await new AgentRunner({ provider, registry, systemPrompt: '', config: { ...DEFAULT_TURN_CONFIG, maxToolCallsPerTurn: 3 },
    context: createDvalinContext({ approvalMode: 'full-auto' }) }).runTurn('go', []);
  expect(check).toHaveBeenCalledTimes(1);
  expect(result.stopReason).toBe('max_tool_calls');
  expect(result.messages.at(-1)?.content).toContain('No tool-call budget remains for edit diagnostics');
});

it('does not allow automatic hooks to bypass a missing approval channel', async () => {
  const registry = createDefaultToolRegistry();
  const cwd = await temp();
  await expect(registry.run('write_file', { filePath: 'blocked', content: 'x' },
    createDvalinContext({ cwd, approvalMode: 'auto-edit' }))).rejects.toThrow(/rejected/);
  await expect(readFile(path.join(cwd, 'blocked'))).rejects.toMatchObject({ code: 'ENOENT' });
});
