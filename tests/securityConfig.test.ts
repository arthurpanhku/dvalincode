import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecurityConfig, resolveSecurityPath, writeInitialSecurityConfig } from '../src/security/config.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('security configuration', () => {
  it('initializes a strict new-findings policy while unconfigured projects remain non-blocking', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dvalin-security-config-'));
    cleanups.push(root);
    expect((await loadSecurityConfig(root)).config.gate).toEqual({ severity: 'none', mode: 'all' });
    const file = await writeInitialSecurityConfig(root);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, scanners: ['builtin'], gate: { severity: 'high', mode: 'new' } });
    expect((await loadSecurityConfig(root)).config.gate).toEqual({ severity: 'high', mode: 'new' });
  });

  it('rejects artifact paths that escape the workspace', () => {
    expect(() => resolveSecurityPath('/repo', '../outside.json')).toThrow('must stay inside');
  });
});
