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
