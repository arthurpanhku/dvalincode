import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecutorRequest, RemediationExecutor } from '../src/remediation/executor.js';
import {
  classifyTarget,
  decide,
  notAutoFixableReason,
  runFixLoop,
  type FixLoopInput,
  type FixLoopObservation,
} from '../src/remediation/fixLoop.js';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';
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

const VULNERABLE = 'export function run(input) {\n  return eval(input);\n}\n';
const FIXED = 'export function run(input) {\n  return JSON.parse(input);\n}\n';
const FIXED_WITH_SECRET = 'const api_key = "sk_live_0123456789abcdef";\nexport function run(input) {\n  return JSON.parse(input);\n}\n';

/** An executor that performs one scripted edit per round and records what it was told. */
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
      return { output: `round ${prompts.length} done`, session: 'session-1' };
    },
  };
}

const pass = async (): Promise<{ evidence: SecurityCheckEvidence[]; outputTails: string[] }> => ({
  evidence: [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
  outputTails: [''],
});

async function setup(): Promise<Pick<FixLoopInput, 'cwd' | 'baseCommit' | 'before' | 'targets' | 'baseline'>> {
  const before = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
  return {
    cwd: repo,
    baseCommit: git('rev-parse', 'HEAD').trim(),
    before,
    targets: before.findings,
    baseline: before.findings,
  };
}

function loop(base: Awaited<ReturnType<typeof setup>>, executor: RemediationExecutor, overrides: Partial<FixLoopInput> = {}) {
  return runFixLoop({
    ...base,
    scanners: ['builtin'],
    threshold: 'high',
    maxRounds: 3,
    executor,
    executorLabel: 'dvalin',
    runChecks: pass,
    logDir,
    ...overrides,
  });
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dvalin-fixloop-')));
  logDir = path.join(repo, '..', `${path.basename(repo)}-logs`);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('src/app.js', VULNERABLE);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
});

describe('the fix loop', () => {
  it('verifies in one round when the first fix is clean', async () => {
    const executor = scripted([() => write('src/app.js', FIXED)]);
    const result = await loop(await setup(), executor);
    expect(result.outcome).toBe('verified');
    expect(result.rounds).toHaveLength(1);
    expect(result.record?.verdict.verified).toBe(true);
    expect(verifyFixRecord(result.record).ok).toBe(true);
    expect(result.logPath).toBeTruthy();
  });

  it('feeds back what the fix introduced, and converges on the next round', async () => {
    const executor = scripted([
      () => write('src/app.js', FIXED_WITH_SECRET),
      () => write('src/app.js', FIXED),
    ]);
    const result = await loop(await setup(), executor);
    expect(result.outcome).toBe('verified');
    expect(result.rounds.map(round => round.blockingIntroduced)).toEqual([1, 0]);
    const feedback = executor.prompts[1]!;
    expect(feedback.prompt).toContain('Round 2 of 3');
    expect(feedback.prompt).toContain('Introduced by your change (1)');
    expect(feedback.prompt).toContain('dvalin/hardcoded-secret');
    // Delta only: the target it already fixed is not re-listed as open.
    expect(feedback.prompt).not.toContain('Still present');
    expect(feedback.resume).toBe('session-1');
  });

  it('does not accept a suppression as a fix, and tells the executor to remove it', async () => {
    const executor = scripted([
      () => write('.dvalincodeignore', 'src/app.js\n'),
      () => {
        rmSync(path.join(repo, '.dvalincodeignore'));
        write('src/app.js', FIXED);
      },
    ]);
    const result = await loop(await setup(), executor);
    expect(result.rounds[0]).toMatchObject({ remaining: 1, suppressions: 1 });
    expect(executor.prompts[1]!.prompt).toContain('Suppressions you added (1)');
    expect(executor.prompts[1]!.prompt).toContain('.dvalincodeignore added');
    expect(executor.prompts[1]!.prompt).toContain('Still present (1)');
    expect(result.outcome).toBe('verified');
  });

  it('passes a failing check\'s output back so the executor can act on it', async () => {
    let call = 0;
    const executor = scripted([() => write('src/app.js', FIXED), () => undefined]);
    const result = await loop(await setup(), executor, {
      runChecks: async () => (call++ === 0
        ? { evidence: [{ kind: 'test', command: 'npm run test', exitCode: 1, passed: false }], outputTails: ['FAIL app.test.js\n  expected 2, received undefined'] }
        : pass()),
    });
    expect(executor.prompts[1]!.prompt).toContain('`npm run test` exited 1');
    expect(executor.prompts[1]!.prompt).toContain('expected 2, received undefined');
    expect(result.outcome).toBe('verified');
    // The output went to the executor, never into the record.
    expect(JSON.stringify(result.record)).not.toContain('received undefined');
  });

  it('stops as stalled when a round leaves exactly the same problems open', async () => {
    const executor = scripted([() => undefined, () => undefined, () => undefined]);
    const result = await loop(await setup(), executor);
    expect(result.outcome).toBe('stalled');
    expect(result.rounds).toHaveLength(2);
    expect(executor.prompts[1]!.prompt).toContain('left no change in the working tree');
    expect(result.record?.verdict.verified).toBe(false);
  });

  it('stops at the round budget', async () => {
    const executor = scripted([() => write('src/app.js', FIXED_WITH_SECRET)]);
    const result = await loop(await setup(), executor, { maxRounds: 1 });
    expect(result.outcome).toBe('budget-exhausted');
    expect(result.rounds).toHaveLength(1);
  });

  it('stops as unverifiable when no check can run, instead of looping on it', async () => {
    const executor = scripted([() => write('src/app.js', FIXED)]);
    const result = await loop(await setup(), executor, { runChecks: async () => ({ evidence: [], outputTails: [] }) });
    expect(result.outcome).toBe('unverifiable');
    expect(result.rounds).toHaveLength(1);
  });

  it('hands dependency findings with no fixed version to a person and loops on the rest', async () => {
    const base = await setup();
    const unfixable: RemediationFinding = {
      id: 'dep',
      source: 'Snyk Open Source',
      scanner: 'snyk-oss',
      ruleId: 'SNYK-JS-ABANDONED-1',
      severity: 'error',
      message: 'abandoned@1.0.0: No upgrade or patch available',
      path: 'package.json',
      tags: [],
      prompt: '',
    };
    const executor = scripted([() => write('src/app.js', FIXED)]);
    const result = await loop({ ...base, targets: [...base.targets, unfixable] }, executor);
    expect(result.needsHuman.map(entry => entry.finding.ruleId)).toEqual(['SNYK-JS-ABANDONED-1']);
    expect(executor.prompts[0]!.prompt).not.toContain('SNYK-JS-ABANDONED-1');
    expect(result.outcome).toBe('verified');

    const onlyUnfixable = await loop({ ...base, targets: [unfixable] }, scripted([]));
    expect(onlyUnfixable.outcome).toBe('not-auto-fixable');
    expect(onlyUnfixable.rounds).toEqual([]);
  });
});

describe('the stop rule', () => {
  const observation = (open: string[], extra: Partial<FixLoopObservation> = {}): FixLoopObservation => ({
    scan: {} as FixLoopObservation['scan'],
    checks: [{ kind: 'test', command: 't', exitCode: 0, passed: true }],
    checkTails: [''],
    suppressions: [],
    remaining: [],
    introduced: [],
    blocking: [],
    incompleteEngines: [],
    hasChanges: true,
    open,
    ...extra,
  });

  it('calls oscillation stalled: fixing one thing while breaking another for two rounds', () => {
    // Round 2 got to 1 open; rounds 3 and 4 trade problems without beating it.
    expect(decide(observation(['b', 'c']), observation(['a']), { round: 3, maxRounds: 5, best: 1, roundsWithoutImprovement: 0 })).toBeUndefined();
    expect(decide(observation(['d', 'e']), observation(['b', 'c']), { round: 4, maxRounds: 5, best: 1, roundsWithoutImprovement: 1 }))
      .toMatchObject({ outcome: 'stalled' });
  });

  it('treats an engine that could not run as unverifiable, not as something to keep fixing', () => {
    expect(decide(observation(['engine:snyk-code'], { incompleteEngines: ['snyk-code'] }), undefined, { round: 1, maxRounds: 3, best: Infinity, roundsWithoutImprovement: 0 }))
      .toMatchObject({ outcome: 'unverifiable' });
  });
});

describe('target classification', () => {
  it('treats dependency engines and manifests as dependency findings', () => {
    expect(classifyTarget({ scanner: 'snyk-oss', source: 'Snyk Open Source', path: 'package.json' })).toBe('dependency');
    expect(classifyTarget({ source: 'Trivy', path: 'services/api/go.sum' })).toBe('dependency');
    expect(classifyTarget({ scanner: 'snyk-code', source: 'SnykCode', path: 'src/app.js' })).toBe('code');
  });

  it('recognizes advisories with no fixed version', () => {
    expect(notAutoFixableReason({ scanner: 'snyk-oss', source: 'Snyk Open Source', path: 'package.json', message: 'No upgrade or patch available' })).toBeTruthy();
    expect(notAutoFixableReason({ scanner: 'snyk-oss', source: 'Snyk Open Source', path: 'package.json', message: 'Upgrade lodash to 4.17.21' })).toBeUndefined();
    // A code finding is never classified away for its wording.
    expect(notAutoFixableReason({ scanner: 'snyk-code', source: 'SnykCode', path: 'src/a.js', message: 'no fix available' })).toBeUndefined();
  });
});
