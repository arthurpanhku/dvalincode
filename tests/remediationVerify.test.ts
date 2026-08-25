import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProjectVerification, splitCommand } from '../src/remediation/verify.js';
import { AuditSink, readRecords, verifyRecords } from '../src/audit/log.js';
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

  it('looks only for the checks it was asked for', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node -e 0', build: 'node -e 0' } }),
      'utf8',
    );

    const run = await runProjectVerification({ cwd, kinds: ['test'] });

    expect(run.evidence.map(check => check.kind)).toEqual(['test']);
    expect(run.skipped).toEqual([]);
  });

  it('writes each observed check into the hash chain, so a record can anchor to it', async () => {
    const auditDir = await mkdtemp(path.join(tmpdir(), 'dvalin-verify-audit-'));
    try {
      const sink = new AuditSink('verify-test', auditDir);
      await runProjectVerification({ cwd, commands: ['node -e process.exit(0)'], audit: sink });

      const records = readRecords('verify-test', auditDir);
      // Same pair the tool-layer tap emits, so readers of the chain keep working.
      const call = records.find(record => record.type === 'tool_call');
      const exec = records.find(record => record.type === 'shell_exec');
      expect(call).toMatchObject({ tool: 'run_check', status: 'ok' });
      expect(exec).toMatchObject({ command: 'node', exitCode: 0 });

      expect(verifyRecords('verify-test', records).ok).toBe(true);
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  it('treats an explicitly empty check list as "run nothing", not as "run the defaults"', async () => {
    await writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node -e 0' } }),
      'utf8',
    );

    const run = await runProjectVerification({ cwd, kinds: [] });

    expect(run.evidence).toEqual([]);
    expect(run.skipped).toEqual([]);
  });

  it('carries on through a check that could not run, instead of abandoning the rest', async () => {
    // A check that cannot execute used to be able to abort the whole
    // verification, losing every check after it and the record with them.
    const run = await runProjectVerification({
      cwd,
      commands: ['definitely-not-a-real-binary-xyz', 'node -e process.exit(0)'],
    });

    expect(run.evidence).toHaveLength(2);
    expect(run.evidence[0]!.passed).toBe(false);
    expect(run.evidence[1]!.passed).toBe(true);
  });

  it('records a policy denial rather than letting the verifier bypass the gate', async () => {
    const auditDir = await mkdtemp(path.join(tmpdir(), 'dvalin-verify-deny-'));
    const policyFile = path.join(auditDir, 'policy.json');
    await writeFile(policyFile, JSON.stringify({ commands: { deny: ['^node'] } }), 'utf8');
    process.env.DVALINCODE_POLICY_FILE = policyFile;
    try {
      const sink = new AuditSink('verify-deny', auditDir);
      const run = await runProjectVerification({ cwd, commands: ['node -e process.exit(0)'], audit: sink });

      expect(run.evidence[0]!.passed).toBe(false);
      expect(run.evidence[0]!.exitCode).toBeNull();
      expect(readRecords('verify-deny', auditDir).some(record => record.type === 'policy_violation')).toBe(true);
    } finally {
      delete process.env.DVALINCODE_POLICY_FILE;
      await rm(auditDir, { recursive: true, force: true });
    }
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
