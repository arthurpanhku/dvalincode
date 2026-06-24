import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ChatMessage, ChatRequest, ProviderAdapter, ChatResponse } from '../src/providers/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createDvalinContext } from '../src/core/context.js';
import type { Tool } from '../src/tools/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProvider(
  responseQueue: Array<string | ((req: ChatRequest) => string)>,
): ProviderAdapter {
  let callIndex = 0;
  const name = 'mock';
  async function chat(request: ChatRequest): Promise<ChatResponse> {
    const entry = responseQueue[callIndex];
    callIndex = (callIndex + 1) % responseQueue.length;
    const content = typeof entry === 'function' ? entry(request) : entry;
    return { content, model: 'mock-model' };
  }
  return { name, chat };
}

function createEchoProvider(text: string): ProviderAdapter {
  return createMockProvider([text]);
}

function createEchoTool(): Tool<{ text: string }> {
  return {
    name: 'echo',
    description: 'Echo input back',
    access: 'read',
    inputSchema: z.object({ text: z.string() }),
    async run(input) {
      return { title: 'Echo', output: input.text };
    },
  };
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
  it('parses @tool syntax from LLM response', async () => {
    // The provider responds with a single tool call — no further iterations needed
    const provider = createEchoProvider(
      '@tool("echo", {"text": "hello world"})\nThe tool will echo back.',
    );

    // We need the runner to parse… but we need to test parse internals.
    // Let's dynamically import the module to test the runner through its public API.
    const { AgentRunner } = await import('../src/agent/runner.js');
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const runner = new AgentRunner({
      provider,
      registry,
      context: createDvalinContext(),
      config: { maxIterations: 3, maxToolCallsPerTurn: 5, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: 'You are a coding agent.',
    });

    const result = await runner.runTurn('do something', []);

    // The tool call was parsed and executed, then the runner looped back.
    // Since we only queued one response, the second iteration gets the same response
    // (the mock loops). The runner will exercise maxIterations if we don't get a
    // non-tool-call response. Let's check that tool messages were added.
    const toolMessages = result.messages.filter(m => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('[Tool echo result]');
    expect(toolMessages[0].content).toContain('hello world');
  });

  it('returns final response when no tool calls', async () => {
    const { AgentRunner } = await import('../src/agent/runner.js');
    const provider = createEchoProvider('This is the final answer.');
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const runner = new AgentRunner({
      provider,
      registry,
      context: createDvalinContext(),
      config: { maxIterations: 5, maxToolCallsPerTurn: 5, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: 'You are helpful.',
    });

    const result = await runner.runTurn('hello', []);

    expect(result.finalResponse).toBe('This is the final answer.');
    expect(result.iterationsUsed).toBe(1);
  });

  it('handles tool call parse errors gracefully', async () => {
    const { AgentRunner } = await import('../src/agent/runner.js');
    const provider = createEchoProvider('@tool("nonexistent", {"x": 1})');
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const runner = new AgentRunner({
      provider,
      registry,
      context: createDvalinContext(),
      config: { maxIterations: 2, maxToolCallsPerTurn: 5, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: 'You are helpful.',
    });

    const result = await runner.runTurn('run tool', []);

    const toolMessages = result.messages.filter(m => m.role === 'tool');
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain('[Tool nonexistent error]');
  });
});

// ---------------------------------------------------------------------------
// parseToolCalls  (tested via a small module-level helper)
// ---------------------------------------------------------------------------

describe('parseToolCalls', () => {
  it('extracts @tool calls from response text', async () => {
    const { AgentRunner } = await import('../src/agent/runner.js');
    // Access the private method via prototype (for testing only)
    const runner = new AgentRunner({
      provider: createEchoProvider(''),
      registry: new ToolRegistry(),
      context: createDvalinContext(),
      config: { maxIterations: 2, maxToolCallsPerTurn: 5, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: '',
    });

    const parseMethod = (AgentRunner.prototype as any).parseToolCalls as (content: string) => any[];
    const result = parseMethod.call(runner, '@tool("read_file", {"path": "test.txt"})');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('read_file');
    expect(result[0].arguments).toBe('{"path": "test.txt"}');
  });

  it('extracts multiple tool calls', async () => {
    const { AgentRunner } = await import('../src/agent/runner.js');
    const runner = new AgentRunner({
      provider: createEchoProvider(''),
      registry: new ToolRegistry(),
      context: createDvalinContext(),
      config: { maxIterations: 2, maxToolCallsPerTurn: 5, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: '',
    });

    const parseMethod = (AgentRunner.prototype as any).parseToolCalls as (content: string) => any[];
    const content = [
      '@tool("read_file", {"path": "a.txt"})',
      'Some text between',
      '@tool("search_text", {"pattern": "foo"})',
    ].join('\n');
    const result = parseMethod.call(runner, content);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('read_file');
    expect(result[1].name).toBe('search_text');
  });
});

// ---------------------------------------------------------------------------
// AgentLoop
// ---------------------------------------------------------------------------

describe('AgentLoop', () => {
  it('processes a simple message through turn states', async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    const provider = createEchoProvider('Hello! How can I help?');
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const loop = new AgentLoop({
      provider,
      registry,
      context: createDvalinContext(),
      systemPrompt: 'You are helpful.',
    });

    const result = await loop.processMessage('Hi there!', []);

    // Should go through the state machine and return a response
    expect(result.output).toBe('Hello! How can I help?');
    expect(result.iterationsUsed).toBe(1);
    // Should have user message + assistant response
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('Hi there!');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('records the governing policy hash and provenance in run_start', async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    const { readRecords } = await import('../src/audit/log.js');
    const { loadPolicy } = await import('../src/core/policy.js');

    const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-runstart-'));
    const loaded = loadPolicy(process.cwd());

    const registry = new ToolRegistry();
    registry.register(createEchoTool());
    const loop = new AgentLoop({
      provider: createEchoProvider('done'),
      registry,
      context: createDvalinContext({ policy: loaded.policy }),
      systemPrompt: 'x',
      audit: { dir, model: 'm', policy: loaded },
    });

    const result = await loop.processMessage('hi', []);
    const records = readRecords(result.runId!, dir);
    const start = records.find(r => r.type === 'run_start');
    expect(start).toBeDefined();
    if (start && start.type === 'run_start') {
      expect(start.policyHash).toMatch(/^[a-f0-9]{64}$/);
      expect(start.policyHash).toBe(loaded.hash);
      expect(start.policySources).toHaveLength(loaded.sources.length);
      expect(start.task).toContain('minimized sha256:');
      expect(start.task).not.toBe('hi');
    }
  });

  it('records sessionId in run_start and returns an audit checkpoint head', async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    const { readRecords } = await import('../src/audit/log.js');

    const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-anchor-'));
    const registry = new ToolRegistry();
    registry.register(createEchoTool());
    const loop = new AgentLoop({
      provider: createEchoProvider('done'),
      registry,
      context: createDvalinContext(),
      systemPrompt: 'x',
      audit: { dir, model: 'm', sessionId: 'dc_sess_42' },
    });

    const result = await loop.processMessage('hi', []);

    // The audit chain head is returned so the session journal can anchor to it.
    expect(result.auditHead).toMatch(/^[a-f0-9]{64}$/);
    const records = readRecords(result.runId!, dir);
    const start = records.find(r => r.type === 'run_start');
    expect(start && start.type === 'run_start' ? start.sessionId : undefined).toBe('dc_sess_42');
  });

  it("AgentLoop's /compact command reduces message count", async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    const provider = createEchoProvider('dummy');
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const loop = new AgentLoop({
      provider,
      registry,
      context: createDvalinContext(),
      systemPrompt: 'System prompt',
    });

    // Create a long history (more than 10 messages)
    const history: ChatMessage[] = [{ role: 'system', content: 'You are helpful.' }];
    for (let i = 0; i < 15; i++) {
      history.push({ role: 'user', content: `msg ${i}` });
      history.push({ role: 'assistant', content: `resp ${i}` });
    }

    const result = await loop.processMessage('/compact', history);

    // /compact command should produce output text
    expect(result.output).toContain('Compacted');
    // Should be smaller than original
    expect(result.messages.length).toBeLessThan(history.length);
  });

  it('auto-compacts history when token estimate exceeds the configured threshold', async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    // First provider call is the compaction summary; second is the actual turn.
    const provider = createMockProvider(['STRUCTURED SUMMARY', 'Done, how else can I help?']);
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const loop = new AgentLoop({
      provider,
      registry,
      context: createDvalinContext(),
      systemPrompt: 'System prompt',
      // Tiny window so a modest history trips the 0.5 threshold (> 100 tokens).
      config: { maxIterations: 3, maxToolCallsPerTurn: 5, contextTokenLimit: 200, compactThreshold: 0.5 },
    });

    // Long, bulky history (> 10 messages, well over ~100 estimated tokens).
    const filler = 'x'.repeat(60);
    const history: ChatMessage[] = [{ role: 'system', content: 'You are helpful.' }];
    for (let i = 0; i < 15; i++) {
      history.push({ role: 'user', content: `user message ${i} ${filler}` });
      history.push({ role: 'assistant', content: `assistant reply ${i} ${filler}` });
    }

    const result = await loop.processMessage('Continue please', history);

    // The state machine should have entered COMPACT, replacing the bulky history
    // with a summary message before running the turn.
    expect(result.messages.some(m => m.content.includes('[Conversation summary]'))).toBe(true);
    expect(result.messages.length).toBeLessThan(history.length);
    // The turn still completed after compaction.
    expect(result.output).toBe('Done, how else can I help?');
  });

  it('does not auto-compact when history is under the threshold', async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    const provider = createMockProvider(['Sure, here you go.']);
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    const loop = new AgentLoop({
      provider,
      registry,
      context: createDvalinContext(),
      systemPrompt: 'System prompt',
      config: { maxIterations: 3, maxToolCallsPerTurn: 5, contextTokenLimit: 128_000, compactThreshold: 0.7 },
    });

    const history: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    const result = await loop.processMessage('one more thing', history);

    // No compaction should have happened — no summary message injected.
    expect(result.messages.some(m => m.content.includes('[Conversation summary]'))).toBe(false);
    expect(result.output).toBe('Sure, here you go.');
  });

  it('slash command dispatch works', async () => {
    const { AgentLoop } = await import('../src/agent/loop.js');
    const provider = createEchoProvider('dummy');
    const registry = new ToolRegistry();
    registry.register(createEchoTool());

    let cmdHandled = false;

    const loop = new AgentLoop({
      provider,
      registry,
      context: createDvalinContext(),
      systemPrompt: 'System prompt',
      slashCommands: [
        {
          name: 'testcmd',
          description: 'A test command',
          handler: (_args, messages) => {
            cmdHandled = true;
            return { messages, output: 'test command executed' };
          },
        },
      ],
    });

    const result = await loop.processMessage('/testcmd some args', []);

    expect(cmdHandled).toBe(true);
    expect(result.output).toBe('test command executed');
  });
});
