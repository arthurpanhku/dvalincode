import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { snapshotFinding, type SecurityFindingSnapshot } from '../src/security/contracts.js';
import { buildFixRecord, verifyFixRecord, type VerifiedFixRecord } from '../src/security/fixRecord.js';
import { introducedSince, reverifyFixRecord } from '../src/security/reverify.js';
import type { SecurityCheckEvidence } from '../src/security/workflow.js';

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

const VULNERABLE = 'export function run(input) {\n  return eval(input);\n}\n';
const FIXED = 'export function run(input) {\n  return JSON.parse(input);\n}\n';
const POLICY = { version: 1, scanners: ['builtin'], gate: { severity: 'high', mode: 'new' }, checks: ['test'] };

const passing = async (): Promise<SecurityCheckEvidence[]> => [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }];
const failing = async (): Promise<SecurityCheckEvidence[]> => [{ kind: 'test', command: 'npm run test', exitCode: 1, passed: false }];

/** A record as an issuer would claim it — self-consistent, and nothing in it observed by the reverifier. */
function claimFor(targets: SecurityFindingSnapshot[], overrides: { verified?: boolean } = {}): VerifiedFixRecord {
  return buildFixRecord({
    projectId: 'elsewhere',
    executor: 'claude-code',
    before: { scanId: 'claimed-before', completedAt: '2026-01-01T00:00:00Z', coverage: { status: 'complete', scanners: [], exclusions: [], deferred: [], notes: [] }, targets },
    after: { scanId: 'claimed-after', completedAt: '2026-01-01T00:01:00Z', coverage: { status: 'complete', scanners: [], exclusions: [], deferred: [], notes: [] }, remainingTargets: [] },
    regression: { gate: { threshold: 'none', mode: 'new' }, introduced: [] },
    checks: overrides.verified === false ? [] : [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
  });
}

async function baseTargets(): Promise<SecurityFindingSnapshot[]> {
  const result = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
  return result.findings.map(snapshotFinding);
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dvalin-reverify-repo-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('dvalin.security.json', JSON.stringify(POLICY, null, 2));
  write('src/app.js', VULNERABLE);
  commit('base');
  git('branch', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('re-executing a fix record against its base', () => {
  it('confirms a real repair from its own observations, not the claim', async () => {
    const targets = await baseTargets();
    expect(targets.map(target => target.ruleId)).toContain('dvalin/eval');
    write('src/app.js', FIXED);
    commit('fix');

    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: passing });
    expect(report.reasons).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.targets).toMatchObject({ claimed: targets.length, reproduced: targets.length, unreproduced: [] });
    expect(report.base.policy).toBe('base');
    // The fresh record is the runner's, and re-derives on its own.
    expect(report.record.before.scanId).not.toBe('claimed-before');
    expect(report.record.gate).toEqual({ threshold: 'high', mode: 'new' });
    expect(report.record.changes?.files).toEqual(['src/app.js']);
    expect(verifyFixRecord(report.record).ok).toBe(true);
  });

  it('rejects a claim to have fixed a finding the base never had', async () => {
    write('src/app.js', FIXED);
    commit('fix');
    const invented: SecurityFindingSnapshot = {
      fingerprint: 'fp-invented',
      targetFingerprint: 'tfp-invented',
      findingId: 'invented',
      source: 'Dvalin Local Scan',
      scanner: 'builtin',
      ruleId: 'dvalin/sql-string-concatenation',
      severity: 'error',
      message: 'made up',
      path: 'src/db.js',
      tags: [],
    };
    const claim = claimFor([invented]);
    // Offline re-derivation cannot tell: the forgery is self-consistent.
    expect(verifyFixRecord(claim).ok).toBe(true);

    const report = await reverifyFixRecord({ claim, root: repo, base: 'base', runChecks: passing });
    expect(report.ok).toBe(false);
    expect(report.targets.unreproduced).toHaveLength(1);
    expect(report.reasons.join('\n')).toMatch(/does not exist on base/);
  });

  it('rejects a claimed repair whose target is still on head', async () => {
    const targets = await baseTargets();
    write('README.md', 'touched, not fixed\n');
    commit('not a fix');
    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: passing });
    expect(report.ok).toBe(false);
    expect(report.record.outcome).toBe('target-remains');
    expect(report.notes.join('\n')).toMatch(/claimed record said VERIFIED/);
  });

  it('uses exit codes it observed, not the ones the claim reports', async () => {
    const targets = await baseTargets();
    write('src/app.js', FIXED);
    commit('fix');
    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: failing });
    expect(report.ok).toBe(false);
    expect(report.record.checks[0]).toMatchObject({ exitCode: 1, passed: false });
  });

  it('judges regressions under the base policy, even when the change relaxes its own', async () => {
    const targets = await baseTargets();
    write('src/app.js', FIXED);
    write('src/config.js', 'export const config = { api_key: "sk_live_0123456789abcdef" };\n');
    write('dvalin.security.json', JSON.stringify({ ...POLICY, gate: { severity: 'none', mode: 'new' }, checks: [] }, null, 2));
    commit('fix eval, add a secret, relax the gate');

    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: passing });
    expect(report.record.gate?.threshold).toBe('high');
    expect(report.record.after.introduced?.map(finding => finding.ruleId)).toContain('dvalin/hardcoded-secret');
    expect(report.record.outcome).toBe('regressed');
    expect(report.ok).toBe(false);
    expect(report.notes.join('\n')).toMatch(/edits dvalin.security.json/);
  });

  it('does not count a pre-existing finding that only moved as introduced', async () => {
    write('src/other.js', 'export const x = (s) => eval(s);\n');
    commit('base with two evals');
    git('branch', '-f', 'base');
    const targets = (await baseTargets()).filter(target => target.path === 'src/app.js');
    write('src/app.js', FIXED);
    write('src/other.js', '// a new comment shifts the line\n\nexport const x = (s) => eval(s);\n');
    commit('fix app, shift other');

    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: passing });
    expect(report.record.after.introduced).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('does not accept silencing the scanner as a fix', async () => {
    const targets = await baseTargets();
    // The builtin engine honors .dvalincodeignore. Telling it to skip the file
    // makes the finding vanish from an ordinary scan of head.
    write('.dvalincodeignore', 'src/app.js\n');
    commit('ignore instead of fix');
    expect((await runDvalinScanSuite(repo, { scanners: ['builtin'] })).findings).toEqual([]);

    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: passing });
    expect(report.suppressions).toEqual([{ kind: 'ignore-file', path: '.dvalincodeignore', change: 'added' }]);
    expect(report.record.outcome).toBe('target-remains');
    expect(report.ok).toBe(false);
    expect(report.notes.join('\n')).toMatch(/judged with them undone/);
  });

  it('keeps scanner credentials away from the checks it runs, and gives them back afterwards', async () => {
    const targets = await baseTargets();
    write('src/app.js', FIXED);
    commit('fix');
    process.env.SNYK_TOKEN = 'secret-token';
    let seenByChecks: string | undefined = 'unset';
    try {
      await reverifyFixRecord({
        claim: claimFor(targets),
        root: repo,
        base: 'base',
        runChecks: async () => {
          seenByChecks = process.env.SNYK_TOKEN;
          return passing();
        },
      });
      expect(seenByChecks).toBeUndefined();
      expect(process.env.SNYK_TOKEN).toBe('secret-token');
    } finally {
      delete process.env.SNYK_TOKEN;
    }
  });

  it('does not confirm moving eval into a sibling sink, which the scanner alone misses', async () => {
    const targets = await baseTargets();
    write('src/app.js', 'export function run(input) {\n  return new Function(input)();\n}\n');
    commit('evasive fix');
    const report = await reverifyFixRecord({ claim: claimFor(targets), root: repo, base: 'base', runChecks: passing });
    expect(report.record.after.remainingTargets).toEqual([]);
    expect(report.record.outcome).toBe('evaded');
    expect(report.ok).toBe(false);
    expect(report.notes.join('\n')).toMatch(/not a fix: .*code-execution sink/);
  });

  it('refuses a base it cannot resolve', async () => {
    await expect(reverifyFixRecord({ claim: claimFor([]), root: repo, base: 'no-such-ref', runChecks: passing }))
      .rejects.toThrow(/Cannot resolve base revision/);
  });

  it('leaves no base worktree behind', async () => {
    write('src/app.js', FIXED);
    commit('fix');
    await reverifyFixRecord({ claim: claimFor(await baseTargets()), root: repo, base: 'base', runChecks: passing });
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });
});

describe('introducedSince', () => {
  const finding = (fingerprint: string, targetFingerprint: string): SecurityFindingSnapshot => ({
    fingerprint,
    targetFingerprint,
    findingId: fingerprint,
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/eval',
    severity: 'error',
    message: 'm',
    path: 'a.js',
    tags: [],
  });

  it('charges a group only with what it grew by', () => {
    const base = [finding('a@1', 'a'), finding('a@5', 'a')];
    expect(introducedSince(base, [finding('a@2', 'a'), finding('a@6', 'a')])).toEqual([]);
    expect(introducedSince(base, [finding('a@1', 'a'), finding('a@5', 'a'), finding('a@9', 'a')]).map(f => f.fingerprint)).toEqual(['a@9']);
    expect(introducedSince(base, [finding('b@1', 'b')]).map(f => f.fingerprint)).toEqual(['b@1']);
  });
});
