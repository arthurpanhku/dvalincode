import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeRef, isWithinDiffScope, resolveDiffScope } from '../src/remediation/diffScope.js';
import { runLocalSecurityScan } from '../src/remediation/localScan.js';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';

const execFileAsync = promisify(execFile);

describe('resolveDiffScope', () => {
  let cwd: string;

  const git = (...args: string[]) => execFileAsync('git', args, { cwd });

  const commit = async (message: string) => {
    await git('add', '-A');
    await git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', message);
  };

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-diff-scope-'));
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await git('init', '-q', '-b', 'main');
    await writeFile(
      path.join(cwd, 'src', 'app.ts'),
      ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n') + '\n',
      'utf8',
    );
    await commit('base');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('scopes to the lines an uncommitted edit touched', async () => {
    await writeFile(
      path.join(cwd, 'src', 'app.ts'),
      ['const a = 1;', 'const b = 22;', 'const c = 3;', 'const d = 4;'].join('\n') + '\n',
      'utf8',
    );

    const scope = await resolveDiffScope(cwd);

    expect([...scope.files]).toEqual(['src/app.ts']);
    expect([...(scope.lines.get('src/app.ts') ?? [])]).toEqual([2]);
  });

  it('puts an untracked file in scope in full', async () => {
    await writeFile(path.join(cwd, 'src', 'fresh.ts'), 'const e = 5;\n', 'utf8');

    const scope = await resolveDiffScope(cwd);

    expect([...scope.files]).toEqual(['src/fresh.ts']);
    expect(scope.lines.has('src/fresh.ts')).toBe(false);
    expect(isWithinDiffScope(scope, 'src/fresh.ts', 999)).toBe(true);
  });

  it('records every line of a multi-line insertion', async () => {
    await writeFile(
      path.join(cwd, 'src', 'app.ts'),
      ['const a = 1;', 'const x = 9;', 'const y = 9;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n') + '\n',
      'utf8',
    );

    const scope = await resolveDiffScope(cwd);

    expect([...(scope.lines.get('src/app.ts') ?? [])]).toEqual([2, 3]);
  });

  it('records nothing for a hunk that only removed lines', async () => {
    await writeFile(
      path.join(cwd, 'src', 'app.ts'),
      ['const a = 1;', 'const c = 3;', 'const d = 4;'].join('\n') + '\n',
      'utf8',
    );

    const scope = await resolveDiffScope(cwd);

    expect(scope.files.has('src/app.ts')).toBe(true);
    expect(scope.lines.get('src/app.ts')).toBeUndefined();
    expect(isWithinDiffScope(scope, 'src/app.ts', 2)).toBe(true);
  });

  it('reads the index when asked for staged changes, and ignores untracked files', async () => {
    await writeFile(
      path.join(cwd, 'src', 'app.ts'),
      ['const a = 11;', 'const b = 2;', 'const c = 3;', 'const d = 4;'].join('\n') + '\n',
      'utf8',
    );
    await git('add', 'src/app.ts');
    await writeFile(path.join(cwd, 'src', 'untracked.ts'), 'const z = 0;\n', 'utf8');

    const scope = await resolveDiffScope(cwd, { staged: true });

    expect(scope.ref).toBe('staged');
    expect([...scope.files]).toEqual(['src/app.ts']);
    expect([...(scope.lines.get('src/app.ts') ?? [])]).toEqual([1]);
  });

  it('compares against a named revision', async () => {
    await writeFile(
      path.join(cwd, 'src', 'app.ts'),
      ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 44;'].join('\n') + '\n',
      'utf8',
    );
    await commit('second');

    const scope = await resolveDiffScope(cwd, { ref: 'HEAD~1' });

    expect(scope.ref).toBe('HEAD~1');
    expect([...(scope.lines.get('src/app.ts') ?? [])]).toEqual([4]);
  });

  it('refuses a revision that could be read as a flag', async () => {
    expect(() => assertSafeRef('--upload-pack=touch /tmp/pwned')).toThrow(/Refusing to use/);
    expect(() => assertSafeRef('-x')).toThrow(/Refusing to use/);
    await expect(resolveDiffScope(cwd, { ref: '--output=/tmp/x' })).rejects.toThrow(/Refusing to use/);
  });

  it('accepts an ordinary ref range', () => {
    expect(() => assertSafeRef('origin/main...HEAD')).not.toThrow();
    expect(() => assertSafeRef('HEAD~3')).not.toThrow();
  });
});

describe('runLocalSecurityScan with a diff scope', () => {
  let cwd: string;

  const git = (...args: string[]) => execFileAsync('git', args, { cwd });

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-diff-scan-'));
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await git('init', '-q', '-b', 'main');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports the risk the edit introduced and not the one already there', async () => {
    await writeFile(
      path.join(cwd, 'src', 'legacy.ts'),
      [
        'export function old(input: string) {',
        '  return eval(input);', // scanner fixture
        '}',
      ].join('\n') + '\n',
      'utf8',
    );
    await git('add', '-A');
    await git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base');

    // An agent appends a new risk to a file that already had one.
    await writeFile(
      path.join(cwd, 'src', 'legacy.ts'),
      [
        'export function old(input: string) {',
        '  return eval(input);', // scanner fixture
        '}',
        'export function added(req: any) {',
        '  return exec("grep " + req.query.name);', // scanner fixture
        '}',
      ].join('\n') + '\n',
      'utf8',
    );

    const wholeWorkspace = await runLocalSecurityScan(cwd);
    expect(wholeWorkspace.findings.map(finding => finding.ruleId).sort())
      .toEqual(['dvalin/eval', 'dvalin/shell-command-injection']);

    const scoped = await runLocalSecurityScan(cwd, await resolveDiffScope(cwd));
    expect(scoped.findings.map(finding => `${finding.ruleId}:${finding.startLine}`))
      .toEqual(['dvalin/shell-command-injection:5']);
  });

  it('reports nothing when the diff is empty', async () => {
    await writeFile(path.join(cwd, 'src', 'app.ts'), 'const apiKey = "sk-live-1234567890abcdef";\n', 'utf8'); // scanner fixture
    await git('add', '-A');
    await git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base');

    const scoped = await runLocalSecurityScan(cwd, await resolveDiffScope(cwd));

    expect(scoped.findings).toEqual([]);
  });
});

describe('runDvalinScanSuite with a diff scope', () => {
  let cwd: string;

  const git = (...args: string[]) => execFileAsync('git', args, { cwd });

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-diff-suite-'));
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await git('init', '-q', '-b', 'main');
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports what the scan was narrowed to, and drops findings outside it', async () => {
    await writeFile(path.join(cwd, 'src', 'old.ts'), 'const preTax = eval(raw);\n', 'utf8'); // scanner fixture
    await git('add', '-A');
    await git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'base');
    await writeFile(path.join(cwd, 'src', 'new.ts'), 'const afterTax = eval(raw);\n', 'utf8'); // scanner fixture

    const scope = await resolveDiffScope(cwd);
    const result = await runDvalinScanSuite(cwd, { scanners: ['builtin'], scope });

    expect(result.scope).toEqual({ ref: 'HEAD', files: 1 });
    expect(result.findings.map(finding => finding.path)).toEqual(['src/new.ts']);
  });

  it('leaves the result unscoped when no scope is given', async () => {
    await writeFile(path.join(cwd, 'src', 'old.ts'), 'const preTax = eval(raw);\n', 'utf8'); // scanner fixture

    const result = await runDvalinScanSuite(cwd, { scanners: ['builtin'] });

    expect(result.scope).toBeUndefined();
    expect(result.findings).toHaveLength(1);
  });
});
