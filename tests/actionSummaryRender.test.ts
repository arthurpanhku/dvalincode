import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildFixRecord,
  verifyFixRecord,
  type FixRecordGate,
  type FixRecordInput,
} from '../src/security/fixRecord.js';
import type { SecurityCoverage, SecurityFindingSnapshot } from '../src/security/contracts.js';

/**
 * The pull-request comment is JavaScript embedded in YAML embedded in a shell
 * script, so nothing typechecks it and nothing renders it until a real workflow
 * runs. It shipped once already reading only `remainingTargets`, which made a
 * regressed repair's comment look like a clean one's.
 *
 * These run the actual script out of action.yml against records this repo's own
 * builder produced, and assert on the comment a reviewer would read.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYaml = readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
const summaryScript = extractSummaryScript(actionYaml);
const workdirs: string[] = [];

afterAll(() => {
  for (const dir of workdirs) rmSync(dir, { recursive: true, force: true });
});

/** The `node -e '…'` body of the "Build summary" step. */
function extractSummaryScript(yamlText: string): string {
  const step = yamlText.slice(yamlText.indexOf('name: Build summary'));
  const start = step.indexOf("node -e '");
  const body = step.slice(start + "node -e '".length);
  const end = body.indexOf("'\n");
  expect(start, 'the summary step still runs node -e').toBeGreaterThan(-1);
  expect(end, 'the node -e script is still terminated by a single quote').toBeGreaterThan(-1);
  return body.slice(0, end);
}

const complete: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

function finding(overrides: Partial<SecurityFindingSnapshot> = {}): SecurityFindingSnapshot {
  return {
    fingerprint: 'fp-1',
    targetFingerprint: 'tfp-1',
    findingId: 'one',
    source: 'Dvalin Local Scan',
    scanner: 'builtin',
    ruleId: 'dvalin/eval',
    severity: 'error',
    message: 'eval on user input',
    path: 'src/app.ts',
    startLine: 4,
    tags: [],
    ...overrides,
  };
}

const gate: FixRecordGate = { threshold: 'high', mode: 'new' };
const sqlInjection = finding({
  fingerprint: 'fp-new',
  ruleId: 'dvalin/sql-injection',
  securitySeverity: '9.1',
  message: 'string-concatenated SQL',
  path: 'src/db.ts',
  startLine: 31,
});

function input(overrides: Partial<FixRecordInput> = {}): FixRecordInput {
  return {
    projectId: 'abc123',
    executor: 'claude-code',
    before: { scanId: 'scan-a', completedAt: '2026-01-01T00:00:00Z', coverage: complete, targets: [finding()] },
    after: { scanId: 'scan-b', completedAt: '2026-01-01T00:10:00Z', coverage: complete, remainingTargets: [] },
    checks: [{ kind: 'test', command: 'npm run test', exitCode: 0, passed: true }],
    generatedAt: '2026-01-01T00:11:00Z',
    version: '0.18.0',
    ...overrides,
  };
}

/** Runs the extracted script the way the step does: in a directory holding its inputs. */
function renderComment(recordInput: FixRecordInput | null): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dvalin-action-summary-'));
  workdirs.push(dir);
  writeFileSync(
    path.join(dir, 'dvalin-result.json'),
    JSON.stringify({
      score: 100,
      grade: 'A',
      findings: [],
      metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 12 },
      coverage: { status: 'complete', deferred: [], exclusions: [] },
      scanners: [{ id: 'builtin', status: 'completed' }],
    }),
  );
  if (recordInput) {
    const verification = verifyFixRecord(buildFixRecord(recordInput));
    expect(verification.ok, 'the fixture record re-derives').toBe(true);
    writeFileSync(path.join(dir, 'dvalin-fix-record.json'), JSON.stringify(verification));
  }
  execFileSync(process.execPath, ['-e', summaryScript], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  return readFileSync(path.join(dir, 'dvalin-summary.md'), 'utf8');
}

describe('the pull-request comment the action posts', () => {
  it('keeps the node script free of the quote that would break its shell wrapper', () => {
    // The script is passed as `node -e '…'` inside a single-quoted shell word.
    expect(summaryScript).not.toContain("'");
  });

  it('reports a clean v2 repair with the gate it was judged under', () => {
    const body = renderComment(input({ regression: { gate, introduced: [] } }));
    expect(body).toContain('**VERIFIED**');
    expect(body).toContain('- introduced: none (gate high/new)');
    expect(body).toContain('- outcome: `verified`');
  });

  it('names what a regressed repair introduced, and where', () => {
    const body = renderComment(input({ regression: { gate, introduced: [sqlInjection] } }));
    expect(body).toContain('**NOT VERIFIED**');
    expect(body).toContain('- introduced: **1** finding(s) the first scan did not report (gate high/new)');
    // Graded the way the gate read it (securitySeverity 9.1), not as raw SARIF
    // `error` — a listed finding must not look milder than the rule that blocked it.
    expect(body).toContain('  - critical `dvalin/sql-injection` — `src/db.ts:31`');
    expect(body).toContain('- outcome: `regressed`');
  });

  it('says plainly when the verifier did not determine what was introduced', () => {
    const body = renderComment(input({ regression: { gate, introduced: null } }));
    expect(body).toContain('- introduced: **not determined** (gate high/new)');
    expect(body).toContain('- outcome: `unverifiable`');
  });

  it('does not let a v1 record read as though it asked about regressions', () => {
    const body = renderComment(input());
    expect(body).toContain('**VERIFIED**');
    expect(body).toContain('issued under v1 rules');
    expect(body).not.toContain('- introduced:');
    expect(body).not.toContain('- outcome:');
  });

  it('reports a record that does not re-derive instead of rendering it', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dvalin-action-summary-'));
    workdirs.push(dir);
    const record = buildFixRecord(input({ regression: { gate, introduced: [] } }));
    // Edited after issue: the verdict no longer follows from the evidence.
    const tampered = { ...record, after: { ...record.after, remainingTargets: [finding()] } };
    writeFileSync(path.join(dir, 'dvalin-result.json'), JSON.stringify({
      score: 100, grade: 'A', findings: [],
      metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 12 },
      coverage: { status: 'complete', deferred: [], exclusions: [] },
      scanners: [],
    }));
    writeFileSync(path.join(dir, 'dvalin-fix-record.json'), JSON.stringify(verifyFixRecord(tampered)));
    execFileSync(process.execPath, ['-e', summaryScript], { cwd: dir, env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
    const body = readFileSync(path.join(dir, 'dvalin-summary.md'), 'utf8');
    expect(body).toContain('did not re-derive on the runner');
  });
});
