import { describe, expect, it } from 'vitest';
import {
  codexExecExecutor,
  dvalinAgentExecutor,
  parseCodexStream,
  resolveExecutor,
} from '../src/remediation/executor.js';
import { evaluateVerificationGate } from '../src/remediation/automate.js';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';

/** A `codex exec --json` stream, in the shape the harness documents. */
const CODEX_STREAM = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"npm test","status":"completed","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Looking at the finding."}}',
  '{"type":"item.completed","item":{"id":"item_3","type":"command_execution","command":"npm run typecheck","status":"completed","exit_code":0}}',
  '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"Fixed the injection. DVALIN_VERIFICATION_PASSED"}}',
  '{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}',
].join('\n');

describe('parseCodexStream', () => {
  it('takes the thread id as the handle for continuing the conversation', () => {
    expect(parseCodexStream(CODEX_STREAM).session).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });

  it('takes the last agent message as the result, not the first', () => {
    expect(parseCodexStream(CODEX_STREAM).output).toBe('Fixed the injection. DVALIN_VERIFICATION_PASSED');
  });

  it('records each completed command as check evidence', () => {
    expect(parseCodexStream(CODEX_STREAM).evidence).toEqual([
      { kind: 'codex command', command: 'npm test', exitCode: 0, passed: true },
      { kind: 'codex command', command: 'npm run typecheck', exitCode: 0, passed: true },
    ]);
  });

  it('does not count an in-progress command as a completed check', () => {
    expect(parseCodexStream(CODEX_STREAM).evidence.map(check => check.command))
      .not.toContain(undefined);
    expect(parseCodexStream(CODEX_STREAM).evidence).toHaveLength(2);
  });

  it('believes a non-zero exit code over a status that claims success', () => {
    const stream = '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","status":"completed","exit_code":1}}';

    expect(parseCodexStream(stream).evidence).toEqual([
      { kind: 'codex command', command: 'npm test', exitCode: 1, passed: false },
    ]);
  });

  it('falls back to status when the stream carries no exit code', () => {
    const stream = [
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","status":"failed"}}',
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm run build","status":"completed"}}',
    ].join('\n');

    expect(parseCodexStream(stream).evidence.map(check => check.passed)).toEqual([false, true]);
  });

  it('ignores anything on the stream that is not an event', () => {
    const stream = ['not json at all', '', CODEX_STREAM, '   '].join('\n');

    expect(parseCodexStream(stream).output).toBe('Fixed the injection. DVALIN_VERIFICATION_PASSED');
  });

  it('returns an empty turn for an empty stream rather than throwing', () => {
    expect(parseCodexStream('')).toEqual({ output: '', session: undefined, evidence: [] });
  });
});

describe('resolveExecutor', () => {
  it('defaults to Dvalin and finds Codex by name', () => {
    expect(resolveExecutor('dvalin')).toBe(dvalinAgentExecutor);
    expect(resolveExecutor('codex')).toBe(codexExecExecutor);
  });

  /**
   * The distinction the interface exists to make visible. Dvalin reads check
   * exit codes back out of its own audit trail; Codex can only be asked what it
   * ran. Both are usable, but they are not the same guarantee, and the type
   * says so rather than leaving it to a reviewer to notice.
   */
  it('marks only Dvalin as attesting its own evidence', () => {
    expect(dvalinAgentExecutor.attestsEvidence).toBe(true);
    expect(codexExecExecutor.attestsEvidence).toBe(false);
  });
});

describe('the verification gate over executor-reported evidence', () => {
  const finding = (path: string): RemediationFinding => ({
    id: `id-${path}`,
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/eval',
    ruleName: 'Dynamic code execution',
    severity: 'warning',
    securitySeverity: '7.5',
    message: 'eval',
    path,
    startLine: 1,
    endLine: 1,
    helpUri: 'https://cwe.mitre.org/data/definitions/94.html',
    tags: ['security'],
    prompt: '',
  });

  const cleanRescan = {
    findings: [],
    metrics: { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 },
  } as unknown as DvalinScanSuiteResult;

  it('passes when the executor reports checks that all succeeded', () => {
    const gate = evaluateVerificationGate({
      originals: [finding('src/app.ts')],
      after: cleanRescan,
      agentOutput: 'done',
      hasChanges: true,
      checkEvidence: parseCodexStream(CODEX_STREAM).evidence,
    });

    expect(gate).toEqual({ passed: true, reasons: [] });
  });

  it('fails when a reported check failed, even though the re-scan is clean', () => {
    const stream = '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","status":"completed","exit_code":1}}';

    const gate = evaluateVerificationGate({
      originals: [finding('src/app.ts')],
      after: cleanRescan,
      agentOutput: 'all good, honest',
      hasChanges: true,
      checkEvidence: parseCodexStream(stream).evidence,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain('1 recorded check(s) failed');
  });

  /**
   * The property that makes an external executor safe to adopt: prose claiming
   * success cannot substitute for a check that was never run.
   */
  it('fails when the executor ran nothing but says it passed', () => {
    const gate = evaluateVerificationGate({
      originals: [finding('src/app.ts')],
      after: cleanRescan,
      agentOutput: 'Everything verified. DVALIN_VERIFICATION_PASSED',
      hasChanges: true,
      checkEvidence: parseCodexStream('{"type":"item.completed","item":{"type":"agent_message","text":"trust me"}}').evidence,
    });

    expect(gate.passed).toBe(false);
    expect(gate.reasons).toContain('no run_check execution evidence was recorded');
  });
});
