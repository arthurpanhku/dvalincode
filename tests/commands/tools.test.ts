import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Command } from 'commander';
import { registerToolsCommand } from '../../src/commands/tools.js';
import { ToolRegistry, toolParametersSchema } from '../../src/tools/registry.js';
import type { Tool, ToolAccess } from '../../src/tools/types.js';

function tool(name: string, access: ToolAccess, overrides: Partial<Tool<any>> = {}): Tool<any> {
  return {
    name,
    description: `${name} description`,
    access,
    inputSchema: z.object({ pattern: z.string() }),
    async run() {
      return { title: 'ok', output: '' };
    },
    ...overrides,
  } as Tool<any>;
}

function invoke(registry: ToolRegistry, args: string[] = []): string {
  let captured = '';
  const spy = vi.spyOn(console, 'log').mockImplementation(line => {
    captured += `${String(line)}\n`;
  });
  const program = new Command();
  program.exitOverride();
  registerToolsCommand(program, registry);
  program.parse(['node', 'dvalincode', 'tools', ...args]);
  spy.mockRestore();
  return captured;
}

afterEach(() => vi.restoreAllMocks());

describe('tools --json', () => {
  it('reports each tool with the schema needed to call it', () => {
    const registry = new ToolRegistry();
    registry.register(tool('list_files', 'read'));
    const body = JSON.parse(invoke(registry, ['--json']));

    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      name: 'list_files',
      access: 'read',
      description: 'list_files description',
      requiresYes: false,
    });
    expect(body.tools[0].parameters.properties).toHaveProperty('pattern');
  });

  it('gives the caller the same schema the model is given', () => {
    const registry = new ToolRegistry();
    const listFiles = tool('list_files', 'read');
    registry.register(listFiles);
    const body = JSON.parse(invoke(registry, ['--json']));
    // Both go through toolParametersSchema; if that ever forks, an agent
    // reading the CLI would build inputs the model would never produce.
    expect(body.tools[0].parameters).toEqual(toolParametersSchema(listFiles));
  });

  it('prefers a pre-computed schema, as MCP-backed tools carry', () => {
    const native = { type: 'object', properties: { q: { type: 'string' } } };
    const registry = new ToolRegistry();
    registry.register(tool('mcp_thing', 'read', { parametersSchema: native }));
    const body = JSON.parse(invoke(registry, ['--json']));
    expect(body.tools[0].parameters).toEqual(native);
  });

  it('flags exactly the tools that need --yes', () => {
    const registry = new ToolRegistry();
    registry.register(tool('reader', 'read'));
    registry.register(tool('writer', 'write'));
    registry.register(tool('runner', 'execute'));
    const byName = Object.fromEntries(
      JSON.parse(invoke(registry, ['--json'])).tools.map((t: any) => [t.name, t.requiresYes]),
    );
    expect(byName).toEqual({ reader: false, writer: true, runner: true });
  });

  it('emits valid JSON for an empty registry rather than nothing', () => {
    expect(JSON.parse(invoke(new ToolRegistry(), ['--json']))).toEqual({ tools: [] });
  });
});

describe('tools (text)', () => {
  it('keeps columns aligned when one name is far longer than the rest', () => {
    const registry = new ToolRegistry();
    registry.register(tool('git_diff', 'read'));
    registry.register(tool('list_remediation_cases', 'read'));
    const lines = invoke(registry).trim().split('\n');

    // The access column must start at the same offset on every row; a fixed
    // pad width used to break precisely on the long name.
    const offsets = lines.map(line => line.indexOf('read'));
    expect(new Set(offsets).size).toBe(1);
    expect(offsets[0]).toBeGreaterThan('list_remediation_cases'.length);
  });

  it('still prints one row per tool with its description', () => {
    const registry = new ToolRegistry();
    registry.register(tool('git_diff', 'read'));
    const lines = invoke(registry).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('git_diff');
    expect(lines[0]).toContain('git_diff description');
  });
});
