import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hooks = readFileSync(path.join(repoRoot, '.pre-commit-hooks.yaml'), 'utf8');

describe('pre-commit hook definitions', () => {
  it('runs the CLI of the release that carries this file', () => {
    // A user pins `rev: vX`; the hook must then run the vX scanner, not
    // whatever npm calls latest that day.
    const pinned = [...hooks.matchAll(/dvalincode@([0-9][^\s]*)/g)].map(match => match[1]);
    expect(pinned.length).toBeGreaterThan(0);
    for (const version of pinned) expect(version).toBe(VERSION);
  });

  it('scans the workspace under its policy instead of being handed file names', () => {
    expect(hooks).toContain('id: dvalin-scan\n');
    expect(hooks).toContain('id: dvalin-scan-installed\n');
    expect(hooks.match(/pass_filenames: false/g)).toHaveLength(2);
    expect(hooks).not.toMatch(/--fail-on/);
  });
});
