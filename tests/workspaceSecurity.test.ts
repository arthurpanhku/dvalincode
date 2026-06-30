import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveInsideWorkspace, resolveRelativeInside } from '../src/core/workspace.js';

describe('workspace path security', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-workspace-'));
    await mkdir(path.join(cwd, 'src'));
    await writeFile(path.join(cwd, 'src', 'app.ts'), 'const ok = true;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('resolves relative files inside the workspace', async () => {
    const resolved = await resolveInsideWorkspace(cwd, 'src/app.ts');
    const expected = await realpath(path.join(cwd, 'src', 'app.ts'));

    expect(resolved).toBe(expected);
  });

  it('rejects traversal and absolute paths', async () => {
    expect(() => resolveRelativeInside(cwd, '../outside.txt')).toThrow(/escapes workspace/);
    await expect(resolveInsideWorkspace(cwd, '/tmp/outside.txt')).rejects.toThrow(/escapes workspace/);
  });
});
