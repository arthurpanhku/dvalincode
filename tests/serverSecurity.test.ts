import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowWorkspaceRoot,
  assertSafeUserPathInput,
  isAllowedRequestOrigin,
  pathIsInside,
  resolveAllowedCwd,
  resolveAllowedNewPath,
} from '../src/server/security.js';

const originalRoots = process.env.DVALINCODE_WORKSPACE_ROOTS;

afterEach(() => {
  if (originalRoots === undefined) {
    delete process.env.DVALINCODE_WORKSPACE_ROOTS;
  } else {
    process.env.DVALINCODE_WORKSPACE_ROOTS = originalRoots;
  }
});

describe('server security helpers', () => {
  it('allows same-origin and loopback browser origins', () => {
    expect(isAllowedRequestOrigin('http://localhost:3000', 'localhost:3000')).toBe(true);
    expect(isAllowedRequestOrigin('http://localhost:5173', '127.0.0.1:3001')).toBe(true);
  });

  it('rejects non-loopback browser origins', () => {
    expect(isAllowedRequestOrigin('https://example.com', '127.0.0.1:3000')).toBe(false);
    expect(isAllowedRequestOrigin('http://evil.test', 'localhost:3000')).toBe(false);
  });

  it('checks real path containment instead of string prefixes', () => {
    const root = path.resolve('/tmp/project');
    expect(pathIsInside(root, path.resolve('/tmp/project/src/index.ts'))).toBe(true);
    expect(pathIsInside(root, path.resolve('/tmp/project-other/src/index.ts'))).toBe(false);
  });

  it('rejects cwd values outside configured workspace roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dvalin-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'dvalin-outside-'));
    const nested = path.join(root, 'nested');
    await mkdir(nested);

    process.env.DVALINCODE_WORKSPACE_ROOTS = await realpath(root);

    await expect(resolveAllowedCwd(nested)).resolves.toBe(await realpath(nested));
    await expect(resolveAllowedCwd(outside)).rejects.toThrow('Workspace is not allowed');
  });

  it('rejects URL-like and control-character path input', () => {
    expect(() => assertSafeUserPathInput('file:///tmp/project')).toThrow('filesystem path');
    expect(() => assertSafeUserPathInput('/tmp/project\0evil')).toThrow('invalid characters');
  });

  it('allows new paths only inside existing workspace roots', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dvalin-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'dvalin-outside-'));
    const nested = path.join(root, 'new-worktree');

    process.env.DVALINCODE_WORKSPACE_ROOTS = await realpath(root);

    await expect(resolveAllowedNewPath(nested)).resolves.toBe(nested);
    await expect(resolveAllowedNewPath(path.join(outside, 'new-worktree'))).rejects.toThrow('Workspace is not allowed');
  });

  it('registers an explicitly granted workspace root after validation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dvalin-picked-'));
    await expect(allowWorkspaceRoot(root)).resolves.toBe(path.resolve(root));
  });
});
