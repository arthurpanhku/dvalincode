import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutorRequest, RemediationExecutor } from '../src/remediation/executor.js';
import { detectEvasion, isTestPath, sinkFamilyOf } from '../src/remediation/evasion.js';
import { runFixLoop, type FixLoopInput } from '../src/remediation/fixLoop.js';
import { classifyReproExit, reproCommand, resolveReproRunner, type ReproRunner } from '../src/remediation/reproduce.js';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { snapshotFinding, type SecurityFindingSnapshot } from '../src/security/contracts.js';
import { verifyFixRecord } from '../src/security/fixRecord.js';
import type { SecurityCheckEvidence } from '../src/security/workflow.js';

let repo: string;
let logDir: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(file: string, content: string): void {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function remove(file: string): void {
  rmSync(path.join(repo, file), { force: true });
}

const VULNERABLE = 'export function run(input) {\n  return eval(input);\n}\n';
const FIXED = 'export function run(input) {\n  return JSON.parse(input);\n}\n';
const SIBLING_SINK = 'export function run(input) {\n  return new Function(input)();\n}\n';

/** Fails while `run` executes code, passes once it does not. */
const REPRO_TEST = `import test from 'node:test';
import assert from 'node:assert';
import { run } from '../src/app.js';

test('run does not execute attacker-supplied code', () => {
  globalThis.pwned = false;
  try { run('globalThis.pwned = true'); } catch {}
  assert.strictEqual(globalThis.pwned, false);
});
`;
/** Passes whatever the code does — not a reproduction. */
const VACUOUS_TEST = `import test from 'node:test';
test('nothing', () => {});
`;

const NODE_RUNNER: ReproRunner = { template: 'node --test {files}', source: 'flag', errorExitCodes: [126, 127] };

function scripted(steps: Array<() => void>): RemediationExecutor & { prompts: ExecutorRequest[] } {
  const prompts: ExecutorRequest[] = [];
  return {
    id: 'dvalin',
    name: 'scripted executor',
    prompts,
    async unavailableReason() { return undefined; },
    async run(request) {
      prompts.push(request);
      steps[prompts.length - 1]?.();
      return { output: 'done', session: 's' };
    },
  };
}

const pass = async (): Promise<{ evidence: SecurityCheckEvidence[]; outputTails: string[] }> => ({
  evidence: [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
  outputTails: [''],
});

async function loop(executor: RemediationExecutor, overrides: Partial<FixLoopInput> = {}) {
  const before = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
  return runFixLoop({
    cwd: repo,
    baseCommit: git('rev-parse', 'HEAD').trim(),
    before,
    targets: before.findings,
    baseline: before.findings,
    scanners: ['builtin'],
    threshold: 'high',
    maxRounds: 3,
    executor,
    executorLabel: 'dvalin',
    runChecks: pass,
    logDir,
    reproduce: { runner: NODE_RUNNER, rounds: 2 },
    ...overrides,
  });
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dvalin-repro-')));
  logDir = `${repo}-logs`;
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('package.json', '{"type":"module"}\n');
  write('src/app.js', VULNERABLE);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

describe('reproduce, then fix', () => {
  it('requires a failing test first, then the same test passing unchanged', async () => {
    const executor = scripted([
      () => write('tests/app.test.js', REPRO_TEST),
      () => write('src/app.js', FIXED),
    ]);
    const result = await loop(executor);

    expect(executor.prompts[0]!.prompt).toContain('Do NOT fix them yet');
    expect(executor.prompts[1]!.prompt).toContain('tests/app.test.js');
    expect(executor.prompts[1]!.prompt).toContain('Do not edit them');
    expect(result.outcome).toBe('verified');
    expect(result.rounds.map(round => round.phase)).toEqual(['reproduce', 'fix']);
    expect(result.reproduction).toMatchObject({ status: 'reproduced', command: 'node --test tests/app.test.js', after: { exitCode: 0 } });
    expect(result.reproduction!.before.exitCode).not.toBe(0);
    // The after-fix run is an ordinary check, so the verdict depends on it.
    expect(result.record!.checks).toContainEqual(expect.objectContaining({ kind: 'reproduce', passed: true }));
    expect(result.record!.reproduction?.status).toBe('reproduced');
    expect(verifyFixRecord(result.record).ok).toBe(true);
  });

  it('sends a reproduction back when it also changed the code', async () => {
    const executor = scripted([
      () => { write('tests/app.test.js', REPRO_TEST); write('src/app.js', FIXED); },
      () => write('src/app.js', VULNERABLE),
      () => write('src/app.js', FIXED),
    ]);
    const result = await loop(executor);
    expect(result.rounds[0]).toMatchObject({ phase: 'reproduce' });
    expect(result.rounds[0]!.problems!.join(' ')).toMatch(/only tests may change.*src\/app\.js/);
    expect(executor.prompts[1]!.prompt).toContain('Reproduction attempt 2 of 2');
    expect(result.outcome).toBe('verified');
  });

  it('hands a finding nobody could demonstrate to a person, and never starts fixing it', async () => {
    const executor = scripted([
      () => write('tests/app.test.js', VACUOUS_TEST),
      () => write('tests/app.test.js', VACUOUS_TEST.replace('nothing', 'still nothing')),
    ]);
    const result = await loop(executor);
    expect(result.outcome).toBe('not-reproduced');
    expect(result.reason).toMatch(/passed on the vulnerable code/);
    expect(executor.prompts).toHaveLength(2);
    expect(result.record).toBeUndefined();
    expect(readFileSync(path.join(repo, 'src/app.js'), 'utf8')).toBe(VULNERABLE);
  });

  it('does not accept a fix that edits the reproduction test to pass', async () => {
    const executor = scripted([
      () => write('tests/app.test.js', REPRO_TEST),
      () => { write('src/app.js', FIXED); write('tests/app.test.js', VACUOUS_TEST); },
      () => write('tests/app.test.js', REPRO_TEST),
    ]);
    const result = await loop(executor);
    expect(result.rounds[1]).toMatchObject({ phase: 'fix', open: 1 });
    expect(executor.prompts[2]!.prompt).toContain('Reproduction tests you changed (1)');
    expect(result.outcome).toBe('verified');
    expect(result.reproduction?.status).toBe('reproduced');
  });

  it('does not ask for a reproduction of dependency findings', async () => {
    const base = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
    const dependency = { ...base.findings[0]!, scanner: 'snyk-oss' as const, source: 'Snyk Open Source', path: 'package.json', ruleId: 'SNYK-JS-X-1' };
    const executor = scripted([() => undefined]);
    const result = await loop(executor, { targets: [dependency], maxRounds: 1 });
    expect(executor.prompts[0]!.prompt).not.toContain('Do NOT fix them yet');
    expect(result.rounds.every(round => round.phase === 'fix')).toBe(true);
  });
});

describe('evasion in the fix loop', () => {
  it('does not accept moving eval into new Function, and says why', async () => {
    const executor = scripted([
      () => write('src/app.js', SIBLING_SINK),
      () => write('src/app.js', FIXED),
    ]);
    const result = await loop(executor, { reproduce: undefined });
    // The builtin rule matches only `eval(`, so the target itself is gone after round 1.
    expect(result.rounds[0]).toMatchObject({ remaining: 0, evasion: 1 });
    expect(executor.prompts[1]!.prompt).toContain('Not accepted as fixes (1)');
    expect(executor.prompts[1]!.prompt).toContain('code-execution sink');
    expect(result.outcome).toBe('verified');
  });

  it('does not accept deleting the vulnerable file', async () => {
    const executor = scripted([() => remove('src/app.js'), () => undefined]);
    const result = await loop(executor, { reproduce: undefined, maxRounds: 2 });
    expect(result.final!.evasion).toEqual([expect.objectContaining({ kind: 'target-file-deleted', path: 'src/app.js' })]);
    expect(result.outcome).not.toBe('verified');
  });
});

describe('detectEvasion', () => {
  const evalTarget = (): SecurityFindingSnapshot => snapshotFinding({
    id: 'e', source: 'Dvalin Local Scan', scanner: 'builtin', ruleId: 'dvalin/eval', severity: 'error',
    message: 'Dynamic code execution detected.', path: 'src/app.js', startLine: 2, tags: [], prompt: '',
  });

  it('flags deleted tests and removed assertions, and leaves a genuine fix alone', async () => {
    write('tests/keep.test.js', 'test(() => {\n  expect(a).toBe(1);\n  expect(b).toBe(2);\n});\n');
    write('tests/gone.test.js', 'test(() => expect(1).toBe(1));\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'tests');
    const base = git('rev-parse', 'HEAD').trim();

    write('src/app.js', FIXED);
    expect(await detectEvasion(repo, base, [evalTarget()])).toEqual([]);

    write('tests/keep.test.js', 'test(() => {\n  expect(a).toBe(1);\n});\n');
    remove('tests/gone.test.js');
    const signals = await detectEvasion(repo, base, [evalTarget()]);
    expect(signals).toEqual(expect.arrayContaining([
      { kind: 'test-deleted', path: 'tests/gone.test.js' },
      { kind: 'assertions-removed', path: 'tests/keep.test.js', removed: 1 },
    ]));
  });

  it('does not count a sibling sink inside a test, where exercising it is the point', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    write('src/app.js', FIXED);
    write('tests/app.test.js', "run('new Function(1)()'); eval('x');\n");
    expect(await detectEvasion(repo, base, [evalTarget()])).toEqual([]);
  });

  it('maps findings to sink families from rule and message', () => {
    expect(sinkFamilyOf({ ruleId: 'javascript/CodeInjection', message: '' })).toBe('code-execution');
    expect(sinkFamilyOf({ ruleId: 'python/CommandInjection', message: '' })).toBe('command-execution');
    expect(sinkFamilyOf({ ruleId: 'dvalin/sql-string-concatenation', message: '' })).toBe('sql');
    expect(sinkFamilyOf({ ruleId: 'javascript/DOMXSS', message: '' })).toBe('html');
    expect(sinkFamilyOf({ ruleId: 'dvalin/hardcoded-secret', message: 'secret' })).toBeUndefined();
    expect(isTestPath('pkg/handler_test.go')).toBe(true);
    expect(isTestPath('src/app.js')).toBe(false);
  });
});

describe('reproduction runner', () => {
  it('infers the runner from the project, and prefers the person\'s choice', async () => {
    write('package.json', '{"devDependencies":{"vitest":"^2.0.0"},"scripts":{"test":"vitest run"}}\n');
    expect(await resolveReproRunner(repo)).toMatchObject({ template: 'npx --no-install vitest run {files}', source: 'inferred' });
    expect(await resolveReproRunner(repo, { configured: 'npm test -- {files}' })).toMatchObject({ source: 'config' });
    expect(await resolveReproRunner(repo, { flag: 'make test FILES={files}', configured: 'x {files}' })).toMatchObject({ source: 'flag' });
    remove('package.json');
    write('pyproject.toml', '[tool.pytest.ini_options]\n');
    expect(await resolveReproRunner(repo)).toMatchObject({ template: 'python -m pytest {files}', errorExitCodes: expect.arrayContaining([5]) });
    remove('pyproject.toml');
    expect(await resolveReproRunner(repo)).toBeUndefined();
  });

  it('builds the command and tells a failing test from a broken runner', () => {
    expect(reproCommand('go test {dirs}', ['pkg/a/x_test.go', 'pkg/a/y_test.go'])).toBe('go test ./pkg/a');
    expect(reproCommand('npx vitest run {files}', ['tests/a b.test.ts'])).toBe('npx vitest run "tests/a b.test.ts"');
    expect(classifyReproExit(NODE_RUNNER, 1, 'AssertionError: expected false')).toBe('failed');
    expect(classifyReproExit(NODE_RUNNER, 0)).toBe('passed');
    expect(classifyReproExit(NODE_RUNNER, 127)).toBe('error');
    expect(classifyReproExit(NODE_RUNNER, 1, "Error: Cannot find module '../src/sanitize.js'")).toBe('error');
    expect(classifyReproExit({ errorExitCodes: [5] }, 5, '')).toBe('error');
  });
});
