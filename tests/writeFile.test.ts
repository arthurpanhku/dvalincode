import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateDiff, formatDiff } from '../src/core/diffPreview.js';
import { writeFileTool } from '../src/tools/writeFile.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createDvalinContext } from '../src/core/context.js';
import type { DvalinContext } from '../src/core/context.js';
import { resolvePolicy } from '../src/core/policy.js';

let tmpDir: string;

function makeContext(overrides?: Partial<DvalinContext>): DvalinContext {
  return createDvalinContext({ cwd: tmpDir, allowWrite: true, ...overrides });
}

function tmpPath(relative: string): string {
  return path.join(tmpDir, relative);
}

function writeSync(relative: string, content: string): void {
  writeFileSync(tmpPath(relative), content, 'utf8');
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dvalincode-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('generateDiff', () => {
  it('detects added lines', () => {
    const original = 'hello\nworld';
    const updated = 'hello\nworld\nnew line';
    const lines = generateDiff(original, updated);
    const keeps = lines.filter(l => l.type === 'keep');
    const adds = lines.filter(l => l.type === 'add');
    expect(keeps).toHaveLength(2);
    expect(adds).toHaveLength(1);
    expect(adds[0]?.content).toBe('new line');
  });

  it('detects removed lines', () => {
    const original = 'hello\nworld\nremoved';
    const updated = 'hello\nworld';
    const lines = generateDiff(original, updated);
    const keeps = lines.filter(l => l.type === 'keep');
    const removes = lines.filter(l => l.type === 'remove');
    expect(keeps).toHaveLength(2);
    expect(removes).toHaveLength(1);
    expect(removes[0]?.content).toBe('removed');
  });

  it('formats diff correctly', () => {
    const original = 'aaa\nbbb';
    const updated = 'aaa\nccc';
    const lines = generateDiff(original, updated);
    const formatted = formatDiff(lines);
    expect(formatted).toContain('  aaa');
    expect(formatted).toContain('- bbb');
    expect(formatted).toContain('+ ccc');
  });
});

describe('writeFileTool', () => {
  it('creates a new file', async () => {
    const context = makeContext();
    const result = await writeFileTool.run(
      { filePath: 'new-file.txt', content: 'hello world' },
      context,
    );

    expect(result.title).toBe('Write new-file.txt');
    expect(result.metadata?.existed).toBe(false);
    expect(readFileSync(tmpPath('new-file.txt'), 'utf8')).toBe('hello world');
  });

  it('reports diff for existing file', async () => {
    writeSync('existing.txt', 'old line');
    const context = makeContext();
    const result = await writeFileTool.run(
      { filePath: 'existing.txt', content: 'new line' },
      context,
    );

    expect(result.title).toBe('Write existing.txt');
    expect(result.metadata?.existed).toBe(true);

    const output = result.output;
    expect(output).toContain('- old line');
    expect(output).toContain('+ new line');
    // Verify the file was overwritten
    expect(readFileSync(tmpPath('existing.txt'), 'utf8')).toBe('new line');
  });

  it('blocks write when allowWrite is false (via registry)', async () => {
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const context = createDvalinContext({ cwd: tmpDir, allowWrite: false });
    await expect(
      registry.run('write_file', { filePath: 'blocked.txt', content: 'nope' }, context),
    ).rejects.toThrow('write access');
  });

  it('rejects write outside workspace', async () => {
    const context = makeContext();
    await expect(
      writeFileTool.run({ filePath: '../escape.txt', content: 'nope' }, context),
    ).rejects.toThrow('escapes workspace');
  });

  it('enforces denied paths before creating a new file', async () => {
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    const context = makeContext({
      policy: resolvePolicy([{ paths: { deny: ['tests/**', '**/tests/**'] } }]),
    });

    await expect(
      registry.run('write_file', { filePath: 'tests/generated_fixture.py', content: 'x = 1' }, context),
    ).rejects.toThrow('Blocked by policy');
  });
});
