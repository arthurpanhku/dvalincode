import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutorRequest, RemediationExecutor } from '../src/remediation/executor.js';
import { runFixLoop } from '../src/remediation/fixLoop.js';
import { syncWithUpstream } from '../src/remediation/rebase.js';
import { hashFiles, type ReproRunner } from '../src/remediation/reproduce.js';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { snapshotFinding } from '../src/security/contracts.js';
import { buildFixRecord, type FixRecordReproduction } from '../src/security/fixRecord.js';
import { rerunReproduction } from '../src/security/reproduceInCi.js';
import { reverifyFixRecord } from '../src/security/reverify.js';
import { runProjectVerification } from '../src/remediation/verify.js';
import type { SecurityCheckEvidence } from '../src/security/workflow.js';

let root: string;
let repo: string;
let upstream: string;

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
const git = (...args: string[]) => gitIn(repo, ...args);

function writeIn(cwd: string, file: string, content: string): void {
  const target = path.join(cwd, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const write = (file: string, content: string) => writeIn(repo, file, content);

/** Land a commit on `main` from a second worktree, the way upstream moves while a fix is in flight. */
function upstreamCommit(file: string, content: string, message: string): string {
  writeIn(upstream, file, content);
  gitIn(upstream, 'add', '-A');
  gitIn(upstream, 'commit', '-q', '-m', message);
  return gitIn(upstream, 'rev-parse', 'HEAD').trim();
}

const VULNERABLE = 'export function run(input) {\n  return eval(input);\n}\n';
const FIXED = 'export function run(input) {\n  return JSON.parse(input);\n}\n';

function scripted(steps: Array<(request: ExecutorRequest) => void>): RemediationExecutor & { prompts: ExecutorRequest[] } {
  const prompts: ExecutorRequest[] = [];
  return {
    id: 'dvalin',
    name: 'scripted executor',
    prompts,
    async unavailableReason() { return undefined; },
    async run(request) {
      prompts.push(request);
      steps[prompts.length - 1]?.(request);
      return { output: 'done', session: 's' };
    },
  };
}

const pass = async (): Promise<{ evidence: SecurityCheckEvidence[]; outputTails: string[] }> => ({
  evidence: [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
  outputTails: [''],
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dvalin-rebase-')));
  repo = path.join(root, 'work');
  upstream = path.join(root, 'upstream');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('package.json', '{"type":"module"}\n');
  write('src/app.js', VULNERABLE);
  write('src/other.js', 'export const greeting = "hello";\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'fix');
  git('worktree', 'add', '-q', upstream, 'main');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('syncWithUpstream', () => {
  it('rebases uncommitted work onto a moved upstream and leaves it uncommitted', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    write('src/app.js', FIXED);
    const tip = upstreamCommit('src/other.js', 'export const greeting = "hi";\n', 'upstream change');

    const result = await syncWithUpstream({ cwd: repo, baseCommit: base, onto: 'main', maxConflictRounds: 1, resolveConflicts: async () => undefined });
    expect(result).toMatchObject({ status: 'rebased', to: tip, base: tip, conflicts: [] });
    expect(git('rev-parse', 'HEAD').trim()).toBe(tip);
    expect(git('status', '--porcelain').trim()).toBe('M src/app.js');
    expect(readFileSync(path.join(repo, 'src/other.js'), 'utf8')).toContain('hi');
  });

  it('does nothing when upstream has not moved', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    write('src/app.js', FIXED);
    expect(await syncWithUpstream({ cwd: repo, baseCommit: base, onto: 'main', maxConflictRounds: 1, resolveConflicts: async () => undefined }))
      .toEqual({ status: 'up-to-date', base });
    expect(git('status', '--porcelain').trim()).toBe('M src/app.js');
  });

  it('hands conflicts to the resolver, files named, and continues the rebase itself', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    write('src/app.js', FIXED);
    upstreamCommit('src/app.js', 'export function run(input) {\n  return eval(input.trim());\n}\n', 'upstream touches the same line');
    const asked: string[][] = [];

    const result = await syncWithUpstream({
      cwd: repo, baseCommit: base, onto: 'main', maxConflictRounds: 2,
      resolveConflicts: async files => {
        asked.push(files);
        write('src/app.js', 'export function run(input) {\n  return JSON.parse(input.trim());\n}\n');
      },
    });
    expect(asked).toEqual([['src/app.js']]);
    expect(result).toMatchObject({ status: 'rebased', conflicts: ['src/app.js'] });
    expect(readFileSync(path.join(repo, 'src/app.js'), 'utf8')).toContain('JSON.parse(input.trim())');
    expect(git('status', '--porcelain').trim()).toBe('M src/app.js');
  });

  it('aborts and leaves the work exactly as it was when markers remain', async () => {
    const base = git('rev-parse', 'HEAD').trim();
    write('src/app.js', FIXED);
    upstreamCommit('src/app.js', 'export function run(input) {\n  return eval(input.trim());\n}\n', 'conflicting');

    const result = await syncWithUpstream({ cwd: repo, baseCommit: base, onto: 'main', maxConflictRounds: 2, resolveConflicts: async () => undefined });
    expect(result).toMatchObject({ status: 'conflict', files: ['src/app.js'] });
    expect(git('rev-parse', 'HEAD').trim()).toBe(base);
    expect(readFileSync(path.join(repo, 'src/app.js'), 'utf8')).toBe(FIXED);
    expect(git('status', '--porcelain').trim()).toBe('M src/app.js');
  });
});

describe('the fix loop on a moving base', () => {
  it('rebases before judging, and does not blame the fix for what upstream brought in', async () => {
    const before = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
    const executor = scripted([() => {
      write('src/app.js', FIXED);
      // While the executor worked, upstream landed a hardcoded secret.
      upstreamCommit('src/config.js', 'export const api_key = "sk_live_0123456789abcdef";\n', 'upstream adds a secret');
    }]);
    const result = await runFixLoop({
      cwd: repo,
      baseCommit: git('rev-parse', 'HEAD').trim(),
      before,
      targets: before.findings,
      baseline: before.findings,
      scanners: ['builtin'],
      threshold: 'high',
      maxRounds: 2,
      executor,
      executorLabel: 'dvalin',
      runChecks: pass,
      logDir: path.join(root, 'logs'),
      rebase: { onto: 'main', maxConflictRounds: 1 },
    });
    expect(result.rounds[0]!.rebased).toMatchObject({ conflicts: [] });
    expect(result.final!.blocking).toEqual([]);
    expect(result.outcome).toBe('verified');
    // The record describes the change on top of the new base.
    expect(result.record!.changes?.files).toEqual(['src/app.js']);
  });

  it('stops as rebase-conflict, tree untouched, when conflicts cannot be resolved', async () => {
    const before = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
    const executor = scripted([() => {
      write('src/app.js', FIXED);
      upstreamCommit('src/app.js', 'export function run(input) {\n  return eval(input.trim());\n}\n', 'conflicting');
    }, () => undefined]);
    const result = await runFixLoop({
      cwd: repo,
      baseCommit: git('rev-parse', 'HEAD').trim(),
      before,
      targets: before.findings,
      baseline: before.findings,
      scanners: ['builtin'],
      threshold: 'high',
      maxRounds: 2,
      executor,
      executorLabel: 'dvalin',
      runChecks: pass,
      logDir: path.join(root, 'logs'),
      rebase: { onto: 'main', maxConflictRounds: 1 },
    });
    expect(result.outcome).toBe('rebase-conflict');
    expect(result.reason).toContain('src/app.js');
    expect(executor.prompts[1]!.prompt).toContain('rebase stopped on conflicts');
    expect(readFileSync(path.join(repo, 'src/app.js'), 'utf8')).toBe(FIXED);
  });
});

describe('re-running a reproduction in CI', () => {
  const REPRO_TEST = `import test from 'node:test';
import assert from 'node:assert';
import { run } from '../src/app.js';
test('no code execution', () => {
  globalThis.pwned = false;
  try { run('globalThis.pwned = true'); } catch {}
  assert.strictEqual(globalThis.pwned, false);
});
`;
  const runner: ReproRunner = { template: 'node --test {files}', source: 'config', errorExitCodes: [126, 127] };
  const run = async (command: string) => {
    const result = await runProjectVerification({ cwd: repo, commands: [command] });
    return { exitCode: result.evidence[0]?.exitCode ?? null, tail: result.outputTails[0] ?? '' };
  };

  async function fixedHead(test = REPRO_TEST): Promise<{ base: string; claimed: FixRecordReproduction }> {
    const base = git('rev-parse', 'HEAD').trim();
    write('src/app.js', FIXED);
    write('tests/app.test.js', test);
    git('add', '-A');
    git('commit', '-q', '-m', 'fix with reproduction');
    return {
      base,
      claimed: {
        status: 'reproduced',
        command: 'whatever the record says is ignored',
        tests: await hashFiles(repo, ['tests/app.test.js']),
        before: { exitCode: 1 },
        after: { exitCode: 0 },
      },
    };
  }

  it('confirms by reverting the fix in place, and puts everything back', async () => {
    const { base, claimed } = await fixedHead();
    const result = await rerunReproduction({ root: repo, baseCommit: base, claimed, runner, run });
    expect(result).toMatchObject({ status: 'confirmed', command: 'node --test tests/app.test.js', after: { exitCode: 0 } });
    expect(result.before!.exitCode).not.toBe(0);
    expect(git('status', '--porcelain').trim()).toBe('');
    expect(readFileSync(path.join(repo, 'src/app.js'), 'utf8')).toBe(FIXED);
  });

  it('does not confirm a test that passes with the fix reverted', async () => {
    const { base, claimed } = await fixedHead("import test from 'node:test';\ntest('nothing', () => {});\n");
    const result = await rerunReproduction({ root: repo, baseCommit: base, claimed, runner, run });
    expect(result.status).toBe('not-confirmed');
    expect(result.detail.join(' ')).toMatch(/passed with the fix reverted/);
  });

  it('refuses paths that are not tests, tests that drifted, and runs nothing without a runner', async () => {
    const { base, claimed } = await fixedHead();
    expect((await rerunReproduction({ root: repo, baseCommit: base, claimed: { ...claimed, tests: [{ path: '../../etc/passwd', sha256: null }] }, runner, run })).status).toBe('not-confirmed');
    expect((await rerunReproduction({ root: repo, baseCommit: base, claimed: { ...claimed, tests: [{ path: 'src/app.js', sha256: null }] }, runner, run })).status).toBe('not-confirmed');
    expect((await rerunReproduction({ root: repo, baseCommit: base, claimed: { ...claimed, tests: [{ path: 'tests/app.test.js', sha256: 'f'.repeat(64) }] }, runner, run })).detail.join(' ')).toMatch(/differ/);
    expect((await rerunReproduction({ root: repo, baseCommit: base, claimed, runner: undefined, run })).status).toBe('not-attempted');
  });

  it('is part of reverify: confirmed reproductions land in the fresh record as a check', async () => {
    write('dvalin.security.json', JSON.stringify({ version: 1, scanners: ['builtin'], gate: { severity: 'high', mode: 'new' }, checks: ['test'], reproduce: 'node --test {files}' }));
    git('add', '-A');
    git('commit', '-q', '-m', 'policy');
    const targets = (await runDvalinScanSuite(repo, { scanners: ['builtin'] })).findings.map(snapshotFinding);
    const { base, claimed } = await fixedHead();
    const claim = buildFixRecord({
      projectId: 'p',
      executor: 'codex',
      before: { scanId: 'a', completedAt: '2026-01-01T00:00:00Z', coverage: { status: 'complete', scanners: [], exclusions: [], deferred: [], notes: [] }, targets },
      after: { scanId: 'b', completedAt: '2026-01-01T00:01:00Z', coverage: { status: 'complete', scanners: [], exclusions: [], deferred: [], notes: [] }, remainingTargets: [] },
      regression: { gate: { threshold: 'high', mode: 'new' }, introduced: [] },
      checks: [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
      reproduction: claimed,
    });
    const report = await reverifyFixRecord({
      claim,
      root: repo,
      base,
      runChecks: async () => [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
    });
    expect(report.reproduction?.status).toBe('confirmed');
    expect(report.record.checks).toContainEqual(expect.objectContaining({ kind: 'reproduce', passed: true }));
    expect(report.record.reproduction?.status).toBe('reproduced');
    expect(report.ok).toBe(true);
    expect(git('status', '--porcelain').trim()).toBe('');
  });
});
