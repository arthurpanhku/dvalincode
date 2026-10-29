import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDvalinContext } from '../src/core/context.js';
import { editFileTool } from '../src/tools/editFile.js';
import { writeFileTool } from '../src/tools/writeFile.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { DvalinContext } from '../src/core/context.js';

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

describe('editFileTool', () => {
  it('replaces exact text in an existing file', async () => {
    writeSync('example.txt', 'hello world\nthis is a test\ngoodbye world');
    const context = makeContext();
    const result = await editFileTool.run(
      { filePath: 'example.txt', oldString: 'hello world', newString: 'hi there' },
      context,
    );

    expect(result.title).toBe('Edit example.txt');
    expect(result.output).toContain('Replaced:');
    expect(result.output).toContain('hello world');
    expect(result.metadata?.occurrences).toBe(1);
    expect(readFileSync(tmpPath('example.txt'), 'utf8')).toBe(
      'hi there\nthis is a test\ngoodbye world',
    );
  });

  it('refuses an oldString that matches more than one place and leaves the file untouched', async () => {
    // Editing whichever match came first would silently change code the model
    // may not have meant; it is told to anchor on more context instead.
    const original = 'def a():\n    return None\n\ndef b():\n    return None\n';
    writeSync('ambiguous.py', original);
    await expect(
      editFileTool.run(
        { filePath: 'ambiguous.py', oldString: '    return None', newString: '    return 42' },
        makeContext(),
      ),
    ).rejects.toThrow('matches 2 places');
    expect(readFileSync(tmpPath('ambiguous.py'), 'utf8')).toBe(original);
  });

  it('writes $ sequences in newString literally', async () => {
    // String.prototype.replace would turn `$$` into `$`, `$&` into the match
    // and `$'` / `` $` `` into the text around it.
    writeSync('dollar.sh', 'echo PLACEHOLDER\n');
    const newString = `"pid=$$" IFS=$'\\n' match=$& pre=$\``;
    await editFileTool.run({ filePath: 'dollar.sh', oldString: 'PLACEHOLDER', newString }, makeContext());
    expect(readFileSync(tmpPath('dollar.sh'), 'utf8')).toBe(`echo ${newString}\n`);
  });

  it('refuses an empty oldString', async () => {
    writeSync('empty-anchor.txt', 'content');
    await expect(
      editFileTool.run({ filePath: 'empty-anchor.txt', oldString: '', newString: 'x' }, makeContext()),
    ).rejects.toThrow('must not be empty');
    expect(readFileSync(tmpPath('empty-anchor.txt'), 'utf8')).toBe('content');
  });

  it('shows diff in output', async () => {
    writeSync('greeting.txt', 'foo\nbar\nbaz');
    const context = makeContext();
    const result = await editFileTool.run(
      { filePath: 'greeting.txt', oldString: 'bar', newString: 'qux' },
      context,
    );

    expect(result.output).toContain('- bar');
    expect(result.output).toContain('+ qux');
    // Context lines should appear
    expect(result.output).toContain(' foo');
    expect(result.output).toContain(' baz');
  });

  it('truncates long oldString in the summary', async () => {
    const longStr = 'a'.repeat(100);
    writeSync('long.txt', longStr);
    const context = makeContext();
    const result = await editFileTool.run(
      { filePath: 'long.txt', oldString: longStr, newString: 'b' },
      context,
    );

    // Should be truncated to 60 chars + …
    expect(result.output).toContain('Replaced: "');
    expect(result.output).toContain('…');
    // First 60 chars of the repeated 'a's
    expect(result.output).toContain('a'.repeat(60));
  });

  it('throws if oldString is not found', async () => {
    writeSync('nope.txt', 'some content');
    const context = makeContext();
    await expect(
      editFileTool.run(
        { filePath: 'nope.txt', oldString: 'does not exist', newString: 'x' },
        context,
      ),
    ).rejects.toThrow('Could not find oldString');
  });

  it('throws for file outside workspace', async () => {
    const context = makeContext();
    await expect(
      editFileTool.run(
        { filePath: '../outside.txt', oldString: 'x', newString: 'y' },
        context,
      ),
    ).rejects.toThrow('escapes workspace');
  });

  it('blocks write when allowWrite is false (via registry)', async () => {
    const registry = new ToolRegistry();
    registry.register(writeFileTool);
    registry.register(editFileTool);
    const context = createDvalinContext({ cwd: tmpDir, allowWrite: false });

    // First create the file via writeFileTool with allowWrite true
    const writeCtx = makeContext();
    await writeFileTool.run({ filePath: 'blocked-edit.txt', content: 'original' }, writeCtx);

    await expect(
      registry.run(
        'edit_file',
        { filePath: 'blocked-edit.txt', oldString: 'original', newString: 'changed' },
        context,
      ),
    ).rejects.toThrow('write access');
  });

  it('works via the registry', async () => {
    writeSync('reg-test.txt', 'replace me');
    const registry = new ToolRegistry();
    registry.register(editFileTool);
    const context = makeContext();
    const result = await registry.run(
      'edit_file',
      { filePath: 'reg-test.txt', oldString: 'replace me', newString: 'done' },
      context,
    );

    expect(result.title).toBe('Edit reg-test.txt');
    expect(readFileSync(tmpPath('reg-test.txt'), 'utf8')).toBe('done');
  });
});
