import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Command } from 'commander';
import { registerRunToolCommand } from '../../src/commands/runTool.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { PolicyViolationError } from '../../src/core/policy.js';
import type { Tool } from '../../src/tools/types.js';

// Regression tests for #45: the run-tool CLI entrypoint must enforce org
// policy exactly like the agent path, not bypass it.

function testTool(ran: { value: boolean }): Tool<{ text: string }> {
  return {
    name: 'echo_test',
    description: 'echo for tests',
    access: 'execute',
    inputSchema: z.object({ text: z.string() }),
    policyTargets: input => [{ kind: 'command', value: `echo_test ${input.text}` }],
    async run(input) {
      ran.value = true;
      return { title: 'Echo', output: input.text };
    },
  };
}

function makeProgram(registry: ToolRegistry): Command {
  const program = new Command();
  program.exitOverride(); // surface errors instead of process.exit
  registerRunToolCommand(program, registry);
  return program;
}

async function invoke(program: Command, args: string[]): Promise<void> {
  await program.parseAsync(['node', 'dvalincode', 'run-tool', ...args]);
}

describe('run-tool org policy enforcement (#45)', () => {
  let dir: string;
  afterEach(() => {
    delete process.env.DVALINCODE_POLICY_FILE;
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('blocks a tool denied by policy and never runs it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-'));
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify({ tools: { deny: ['echo_test'] } }));
    process.env.DVALINCODE_POLICY_FILE = policyFile;

    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));

    await expect(invoke(makeProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y'])).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
    expect(ran.value).toBe(false);
  });

  it('blocks a command matching the policy denylist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-'));
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify({ commands: { deny: ['echo_test'] } }));
    process.env.DVALINCODE_POLICY_FILE = policyFile;

    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));

    await expect(invoke(makeProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y'])).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
    expect(ran.value).toBe(false);
  });

  it('runs normally with no policy file (behavior unchanged)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-'));
    process.env.DVALINCODE_POLICY_FILE = join(dir, 'absent.json');

    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await invoke(makeProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y']);
    expect(ran.value).toBe(true);
    expect(log).toHaveBeenCalled();
  });

  it('warns loudly on a malformed policy instead of silently allowing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-'));
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, '{ not json');
    process.env.DVALINCODE_POLICY_FILE = policyFile;

    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await invoke(makeProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignored malformed policy'));
    expect(ran.value).toBe(true); // fail-safe matches runAgentTurn semantics
  });
});

// `--json` exists so an agent does not have to parse prose. These pin the
// shape and, more importantly, that every failure kind is distinguishable
// without matching on the message text.

function jsonProgram(registry: ToolRegistry) {
  const program = new Command();
  program.exitOverride();
  registerRunToolCommand(program, registry);
  return program;
}

function captureJson(): { read: () => any; restore: () => void } {
  let captured = '';
  const spy = vi.spyOn(console, 'log').mockImplementation(line => {
    captured += String(line);
  });
  return { read: () => JSON.parse(captured), restore: () => spy.mockRestore() };
}

describe('run-tool --json', () => {
  let dir: string;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    delete process.env.DVALINCODE_POLICY_FILE;
    if (dir) rmSync(dir, { recursive: true, force: true });
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  function noPolicy(): void {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-json-'));
    process.env.DVALINCODE_POLICY_FILE = join(dir, 'absent.json');
  }

  it('reports success with the tool result and its metadata', async () => {
    noPolicy();
    const registry = new ToolRegistry();
    registry.register({
      ...testTool({ value: false }),
      async run(input: { text: string }) {
        return { title: 'Echo', output: input.text, metadata: { length: input.text.length } };
      },
    } as Tool<{ text: string }>);
    const out = captureJson();

    await invoke(jsonProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y', '--json']);

    expect(out.read()).toEqual({
      ok: true,
      tool: 'echo_test',
      title: 'Echo',
      output: 'hi',
      metadata: { length: 2 },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('distinguishes an unknown tool without running anything', async () => {
    noPolicy();
    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));
    const out = captureJson();

    await invoke(jsonProgram(registry), ['not_a_tool', '-i', '{}', '--json']);

    expect(out.read()).toMatchObject({ ok: false, tool: 'not_a_tool', error: { code: 'unknown_tool' } });
    expect(ran.value).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('distinguishes malformed JSON input', async () => {
    noPolicy();
    const registry = new ToolRegistry();
    registry.register(testTool({ value: false }));
    const out = captureJson();

    await invoke(jsonProgram(registry), ['echo_test', '-i', 'not-json', '-y', '--json']);

    expect(out.read().error.code).toBe('invalid_input');
  });

  it('distinguishes input that does not match the tool schema', async () => {
    noPolicy();
    const registry = new ToolRegistry();
    registry.register(testTool({ value: false }));
    const out = captureJson();

    await invoke(jsonProgram(registry), ['echo_test', '-i', '{"text":123}', '-y', '--json']);

    expect(out.read().error.code).toBe('invalid_tool_input');
  });

  it('distinguishes a missing --yes from a policy denial', async () => {
    noPolicy();
    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));
    const out = captureJson();

    await invoke(jsonProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '--json']);

    expect(out.read().error.code).toBe('permission_denied');
    expect(ran.value).toBe(false);
  });

  it('reports a policy denial as such, and still does not run the tool', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-json-'));
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify({ tools: { deny: ['echo_test'] } }));
    process.env.DVALINCODE_POLICY_FILE = policyFile;

    const ran = { value: false };
    const registry = new ToolRegistry();
    registry.register(testTool(ran));
    const out = captureJson();

    await invoke(jsonProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y', '--json']);

    expect(out.read()).toMatchObject({ ok: false, error: { code: 'policy_denied' } });
    expect(ran.value).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it('keeps stdout parseable when a malformed policy warns', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dc-runtool-json-'));
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, '{ not json');
    process.env.DVALINCODE_POLICY_FILE = policyFile;

    const registry = new ToolRegistry();
    registry.register(testTool({ value: false }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = captureJson();

    await invoke(jsonProgram(registry), ['echo_test', '-i', '{"text":"hi"}', '-y', '--json']);

    expect(warn).toHaveBeenCalled();          // the warning went to stderr
    expect(out.read().ok).toBe(true);         // stdout stayed valid JSON
  });
});
