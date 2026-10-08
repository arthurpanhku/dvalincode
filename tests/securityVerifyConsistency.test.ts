import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { deriveCoverage, evaluateSecurityGate } from '../src/security/contracts.js';
import {
  FIX_RECORD_SCHEMA_V2,
  FIX_RECORD_SCHEMA_V3,
  buildFixRecord,
  verifyFixRecord,
  type FixRecordInput,
} from '../src/security/fixRecord.js';
import { currentHead } from '../src/security/guardedScan.js';
import { createSecurityWorkflow } from '../src/security/workflow.js';
import { runWorkflowVerification } from '../src/security/verifyRun.js';

/**
 * "Verified" has to mean the same thing on every surface. The fix loop and CI
 * `reverify` undid suppressions a change added and recorded its evasions;
 * `dvalin verify` and the MCP `dvalin_verify_findings` tool — the path agents
 * actually call — did not, so a `.dvalincodeignore` entry verified there and
 * not in the loop. These pin the shared path.
 */
let repo: string;
let home: string;
let originalHome: string | undefined;

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
const SIBLING = 'export function run(input) {\n  return new Function(input)();\n}\n';

async function startWorkflow(options: { git: boolean }) {
  const result = await runDvalinScanSuite(repo, { scanners: ['builtin'] });
  const gate = evaluateSecurityGate({ result, threshold: 'high', mode: 'all' });
  expect(gate.blocking.map(finding => finding.ruleId)).toContain('dvalin/eval');
  return createSecurityWorkflow({
    root: repo,
    result,
    gate,
    coverage: deriveCoverage(result),
    ...(options.git ? { gitHead: await currentHead(repo) } : {}),
  });
}

const verify = (workflow: Awaited<ReturnType<typeof startWorkflow>>) => runWorkflowVerification({
  workflow,
  checks: [],
  verifyCommands: ['node -e process.exit(0)'],
});

beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dvalin-consistency-')));
  home = mkdtempSync(path.join(os.tmpdir(), 'dvalin-consistency-home-'));
  originalHome = process.env.DVALINCODE_HOME;
  process.env.DVALINCODE_HOME = home;
  write('src/app.js', VULNERABLE);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DVALINCODE_HOME;
  else process.env.DVALINCODE_HOME = originalHome;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('dvalin verify / dvalin_verify_findings judge like the fix loop', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
  });

  it('does not verify a target silenced with an ignore file', async () => {
    const workflow = await startWorkflow({ git: true });
    write('.dvalincodeignore', 'src/app.js\n');
    // An ordinary scan would now see nothing.
    expect((await runDvalinScanSuite(repo, { scanners: ['builtin'] })).findings).toEqual([]);

    const updated = await verify(workflow);
    const record = updated.verification!.record!;
    expect(record.schema).toBe(FIX_RECORD_SCHEMA_V3);
    expect(record.after.remainingTargets.map(target => target.ruleId)).toContain('dvalin/eval');
    expect(record.verdict.verified).toBe(false);
    expect(updated.state).toBe('needs_work');
  });

  it('does not verify moving eval into new Function, and says why', async () => {
    const workflow = await startWorkflow({ git: true });
    write('src/app.js', SIBLING);
    const record = (await verify(workflow)).verification!.record!;
    expect(record.after.remainingTargets).toEqual([]);
    expect(record.after.evasion).toEqual([{ kind: 'equivalent-sink', path: 'src/app.js', line: 2, family: 'code-execution' }]);
    expect(record.outcome).toBe('evaded');
    expect(record.verdict.verified).toBe(false);
    expect(JSON.stringify(record)).not.toContain('new Function');
  });

  it('verifies a genuine fix, as a v3 record that re-derives', async () => {
    const workflow = await startWorkflow({ git: true });
    write('src/app.js', FIXED);
    const updated = await verify(workflow);
    const record = updated.verification!.record!;
    expect(record).toMatchObject({ schema: FIX_RECORD_SCHEMA_V3, outcome: 'verified', after: { evasion: [] } });
    expect(updated.state).toBe('passed');
    expect(verifyFixRecord(record).ok).toBe(true);
  });
});

describe('outside a git repository', () => {
  it('keeps issuing v2, which says it did not evaluate evasion, and verifies as before', async () => {
    const workflow = await startWorkflow({ git: false });
    write('src/app.js', FIXED);
    const record = (await verify(workflow)).verification!.record!;
    expect(record.schema).toBe(FIX_RECORD_SCHEMA_V2);
    expect(record.verdict.verified).toBe(true);
  });
});

describe('the v3 rule', () => {
  const coverage = { status: 'complete' as const, scanners: [], exclusions: [], deferred: [], notes: [] };
  const input = (evasion: FixRecordInput['evasion']): FixRecordInput => ({
    projectId: 'p',
    before: { scanId: 'a', completedAt: '2026-01-01T00:00:00Z', coverage, targets: [] },
    after: { scanId: 'b', completedAt: '2026-01-01T00:01:00Z', coverage, remainingTargets: [] },
    regression: { gate: { threshold: 'high', mode: 'new' }, introduced: [] },
    checks: [{ kind: 'test', command: 't', exitCode: 0, passed: true }],
    evasion,
  });

  it('fails on evasion, fails on not determined, and passes on none', () => {
    expect(buildFixRecord(input([{ kind: 'test-deleted', path: 'tests/a.test.js' }]))).toMatchObject({ outcome: 'evaded', verdict: { verified: false } });
    expect(buildFixRecord(input(null))).toMatchObject({ outcome: 'unverifiable', verdict: { verified: false } });
    expect(buildFixRecord(input([]))).toMatchObject({ outcome: 'verified', verdict: { verified: true } });
  });

  it('catches an evasion entry removed after issue', () => {
    const record = buildFixRecord(input([{ kind: 'target-file-deleted', path: 'src/app.js', ruleId: 'dvalin/eval' }]));
    const laundered = { ...record, after: { ...record.after, evasion: [] }, verdict: { ...record.verdict, verified: true } };
    expect(verifyFixRecord(laundered).ok).toBe(false);
  });

  it('rejects a v3 record without the evasion field as malformed', () => {
    const record = buildFixRecord(input([]));
    const { evasion: _dropped, ...after } = record.after;
    expect(verifyFixRecord({ ...record, after }).record).toBeUndefined();
  });

  it('leaves v2 records exactly as they were', () => {
    const v2 = buildFixRecord({ ...input(undefined) });
    expect(v2.schema).toBe(FIX_RECORD_SCHEMA_V2);
    expect(v2.after).not.toHaveProperty('evasion');
    expect(verifyFixRecord(v2).ok).toBe(true);
  });
});
