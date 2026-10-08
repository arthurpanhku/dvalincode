import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  blankMarkers,
  detectSuppressionChanges,
  neutralizeSuppressions,
} from '../src/security/suppressionGuard.js';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(file: string, content: string): void {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commit(message: string): string {
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').trim();
}

let base: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dvalin-suppress-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('.snyk', '# Snyk policy\nversion: v1.25.0\nignore: {}\n');
  write('src/app.js', 'const a = 1;\nconst old = eval(a); // nosemgrep\nconst b = 2;\n');
  base = commit('base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('detecting suppressions a change adds', () => {
  it('finds nothing when the change adds none', async () => {
    write('src/app.js', 'const a = 1;\nconst old = eval(a); // nosemgrep\nconst b = 3;\n');
    expect(await detectSuppressionChanges(repo, base)).toEqual([]);
  });

  it('flags edits to ignore files and new inline markers, committed or not', async () => {
    write('.snyk', '# Snyk policy\nversion: v1.25.0\nignore:\n  SNYK-JS-LODASH-567746:\n    - "*": { reason: fix later }\n');
    write('src/app.js', 'const a = 1;\n// deepcode ignore CodeInjection: trusted input\nconst old = eval(a); // nosemgrep\nconst b = 2;\n');
    commit('silence instead of fix');
    write('.semgrepignore', 'src/\n');
    write('src/new.py', 'subprocess.call(cmd, shell=True)  # nosec\n');

    const changes = await detectSuppressionChanges(repo, base);
    expect(changes).toEqual(expect.arrayContaining([
      { kind: 'ignore-file', path: '.snyk', change: 'modified' },
      { kind: 'ignore-file', path: '.semgrepignore', change: 'added' },
      { kind: 'inline', path: 'src/app.js', line: 2, engine: 'snyk-code', marker: 'deepcode ignore' },
      { kind: 'inline', path: 'src/new.py', line: 1, engine: 'gosec/bandit', marker: 'nosec' },
    ]));
    // The base's own `// nosemgrep` moved down a line; it was not added.
    expect(changes.some(change => change.kind === 'inline' && change.marker === 'nosemgrep')).toBe(false);
  });

  it('reports deleting an ignore file too', async () => {
    rmSync(path.join(repo, '.snyk'));
    expect(await detectSuppressionChanges(repo, base)).toEqual([{ kind: 'ignore-file', path: '.snyk', change: 'deleted' }]);
  });
});

describe('neutralizing them for judgement', () => {
  it('restores base ignore files, removes new ones, and blanks only the new markers', async () => {
    write('.snyk', 'ignore: { everything: true }\n');
    write('.semgrepignore', 'src/\n');
    write('src/app.js', 'const a = 1;\nconst x = eval(a); // deepcode ignore CodeInjection: fine\nconst old = eval(a); // nosemgrep\n');

    const changes = await detectSuppressionChanges(repo, base);
    const neutral = await neutralizeSuppressions(repo, base, changes);
    try {
      expect(readFileSync(path.join(neutral.root, '.snyk'), 'utf8')).toBe('# Snyk policy\nversion: v1.25.0\nignore: {}\n');
      expect(existsSync(path.join(neutral.root, '.semgrepignore'))).toBe(false);
      const app = readFileSync(path.join(neutral.root, 'src/app.js'), 'utf8').split('\n');
      expect(app[1]).not.toContain('deepcode ignore');
      expect(app[1]).toHaveLength('const x = eval(a); // deepcode ignore CodeInjection: fine'.length);
      // Unchanged from base: still base policy.
      expect(app[2]).toContain('// nosemgrep');
      // The workspace itself is untouched.
      expect(readFileSync(path.join(repo, '.snyk'), 'utf8')).toBe('ignore: { everything: true }\n');
    } finally {
      await neutral.cleanup();
    }
    expect(existsSync(neutral.root)).toBe(false);
  });

  it('blanks markers without moving any column', () => {
    const line = 'run(cmd)  # nosec B602 // NOSONAR';
    const blanked = blankMarkers(line);
    expect(blanked).toHaveLength(line.length);
    expect(blanked).not.toMatch(/nosec|NOSONAR/);
    expect(blanked.indexOf('run(cmd)')).toBe(0);
  });
});
