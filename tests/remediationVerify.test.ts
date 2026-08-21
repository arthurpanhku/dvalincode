import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProjectVerification, splitCommand } from '../src/remediation/verify.js';
import { pickProjectCheck } from '../src/tools/runCheck.js';
import { evaluateVerificationGate } from '../src/remediation/automate.js';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';

describe('splitCommand', () => {
  it('splits a plain command into argv', () => {
    expect(splitCommand('npm run test')).toEqual({ command: 'npm', args: ['run', 'test'] });
  });

  it('keeps a quoted argument together, so a filter can contain a space', () => {
    expect(splitCommand('npm test -- --grep "two words"'))
      .toEqual({ command: 'npm', args: ['test', '--', '--grep', 'two words'] });
  });

  it('has no shell, so a chained command is one argument and not a second command', () => {
    // Were this handed to a shell, `rm` would run. As argv it is inert.
    expect(splitCommand('node -e 0; rm -rf /'))
      .toEqual({ command: 'node', args: ['-e', '0;', 'rm', '-rf', '/'] });
  });
});

describe('pickProjectCheck', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-verify-pick-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('finds the project scripts a check maps to', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }),
      'utf8',
    );

    expect(await pickProjectCheck(cwd, 'test', [])).toEqual({ command: 'npm', args: ['run', 'test'] });
    expect(await pickProjectCheck(cwd, 'typecheck', [])).toEqual({ command: 'npm', args: ['run', 'typecheck'] });
  });

  it('reports nothing for a check the project does not define', async () => {
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }), 'utf8');

    expect(await pickProjectCheck(cwd, 'build', [])).toBeNull();
  });
});

describe('runProjectVerification', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-verify-run-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('records the exit code of a command that succeeded', async () => {
    const run = await runProjectVerification({ cwd, commands: ['node -e process.exit(0)'] });

    expect(run.evidence).toEqual([
      { kind: 'custom', command: 'node -e process.exit(0)', exitCode: 0, passed: true },
    ]);
  });

  it('records a failure as a failure, whatever the patch claimed', async () => {
    const run = await runProjectVerification({ cwd, commands: ['node -e process.exit(3)'] });

    expect(run.evidence[0]!.exitCode).toBe(3);
    expect(run.evidence[0]!.passed).toBe(false);
  });

  it('runs every command it was given, and does not stop at the first failure', async () => {
    const run = await runProjectVerification({
      cwd,
      commands: ['node -e process.exit(1)', 'node -e process.exit(0)'],
    });

    expect(run.evidence.map(check => check.passed)).toEqual([false, true]);
  });

  it('reports the checks a project does not define instead of inventing them', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'p', scripts: {} }),
      'utf8',
    );

    const run = await runProjectVerification({ cwd });

    expect(run.evidence).toEqual([]);
    expect(run.skipped).toEqual(['test', 'typecheck', 'build']);
  });
});

/**
 * The point of the change: the gate is fed commands Dvalin observed, so an
 * executor's account of itself cannot reach it.
 */
describe('the verification gate over checks Dvalin ran', () => {
  let cwd: string;

  const finding: RemediationFinding = {
    id: 'id-1',
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/eval',
    ruleName: 'Dynamic code execution',
    severity: 'warning',
    securitySeverity: '7.5',
    message: 'eval',
    path: 'src/app.ts',
    startLine: 1,
    endLine: 1,
    helpUri: 'https://cwe.mitre.org/data/definitions/94.html',
    tags: ['security'],
    prompt: '',
  };

  const cleanRescan = {
    findings: [],
    metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 },
  } as unknown as DvalinScanSuiteResult;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-verify-gate-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('passes when the checks Dvalin ran succeeded and the re-scan is clean', async () => {
    const run = await runProjectVerification({ cwd, commands: ['node -e process.exit(0)'] });

    const gate = evaluateVerificationGate({
      originals: [finding],
      after: cleanRescan,
      agentOutput: 'fixed it',
      hasChanges: true,
      checkEvidence: run.evidence,
    });

    expect(gate).toEqual({ passed: true, reasons: [] });
  });

  it('fails on a real failing check even though the patch reported success', async () => {
    const run = await runProjectVerification({ cwd, commands: ['node -e process.exit(1)'] });

    const gate = evaluateVerificationGate({
      originals: [finding],
      after: cleanRescan,
      agentOutput: 'All tests pass. DVALIN_VERIFICATION_PASSED',
      hasChanges: true,
      checkEvidence: run.evidence,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain('1 recorded check(s) failed');
  });

  it('fails when a project defines no checks at all, rather than passing by default', async () => {
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }), 'utf8');
    const run = await runProjectVerification({ cwd });

    const gate = evaluateVerificationGate({
      originals: [finding],
      after: cleanRescan,
      agentOutput: 'nothing to run',
      hasChanges: true,
      checkEvidence: run.evidence,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain('no run_check execution evidence was recorded');
  });
});
