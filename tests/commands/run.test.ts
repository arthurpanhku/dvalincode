import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import { runCommand, type RunCommandIO, type RunCommandOptions } from '../../src/commands/run.js';
import {
  executeHarnessRun,
  type HarnessRunExecution,
  type HarnessRunResult,
} from '../../src/harness/run.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  delete process.env.DVALINCODE_POLICY_FILE;
  delete process.env.DVALINCODE_SESSIONS_DIR;
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-run-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function captureIo(stdinText = '', isTTY = false): RunCommandIO & { out: () => string; err: () => string } {
  let stdout = '';
  let stderr = '';
  const stdin = Readable.from(stdinText ? [stdinText] : []) as Readable & { isTTY?: boolean };
  stdin.isTTY = isTTY;
  return {
    stdin,
    stdout: new Writable({ write(chunk, _encoding, callback) { stdout += chunk.toString(); callback(); } }),
    stderr: new Writable({ write(chunk, _encoding, callback) { stderr += chunk.toString(); callback(); } }),
    out: () => stdout,
    err: () => stderr,
  };
}

function result(overrides: Partial<HarnessRunResult> = {}): HarnessRunResult {
  return {
    ok: true,
    sessionId: 'dc_test',
    runId: 'run_test',
    auditHead: 'abc',
    policyHash: 'policy',
    provider: 'mock',
    model: 'mock-model',
    iterationsUsed: 1,
    toolCalls: 0,
    usage: { inputTokens: 2, outputTokens: 3 },
    wallSeconds: 0.1,
    output: 'done',
    stopReason: 'done',
    ...overrides,
  };
}

describe('dvalincode run command', () => {
  it('returns usage exit 2 and machine-readable JSON when no prompt is provided', async () => {
    const io = captureIo();
    const execute = vi.fn();
    const code = await runCommand([], { outputFormat: 'json' }, io, execute);
    expect(code).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(io.out())).toMatchObject({ ok: false, stopReason: 'error' });
    expect(io.err()).toBe('');
  });

  it('rejects interactive ask mode before starting a run', async () => {
    const io = captureIo();
    const execute = vi.fn();
    const code = await runCommand(['fix', 'it'], { permissionMode: 'ask', outputFormat: 'json' }, io, execute);
    expect(code).toBe(2);
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(io.out()).error).toMatch(/interactive/);
  });

  it('keeps JSON data on stdout and progress on stderr', async () => {
    const io = captureIo();
    const fake: typeof executeHarnessRun = async (_request, hooks) => {
      hooks.onProviderSelected?.('mock', 'm');
      hooks.onEvent?.({ type: 'llm_iteration', iteration: 1 });
      hooks.onEvent?.({ type: 'tool_call', name: 'read_file', id: '1', input: { filePath: 'a.ts' } });
      return { exitCode: 0, result: result({ toolCalls: 1 }) };
    };
    const code = await runCommand(['inspect'], { outputFormat: 'json' }, io, fake);
    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toMatchObject({ ok: true, runId: 'run_test', toolCalls: 1 });
    expect(io.err()).toContain('provider: mock');
    expect(io.err()).toContain('tool#1 read_file');
  });

  it('streams run_start first, result last, filters deltas, and truncates tool output', async () => {
    const io = captureIo();
    const fake: typeof executeHarnessRun = async (_request, hooks) => {
      hooks.onRunStart?.({
        type: 'run_start', sessionId: 'dc_test', runId: 'run_test', provider: 'mock', model: 'm', policyHash: 'p',
      });
      hooks.onEvent?.({ type: 'llm_iteration', iteration: 1 });
      hooks.onEvent?.({ type: 'token_delta', content: 'secret delta' });
      hooks.onEvent?.({ type: 'tool_result', name: 'read_file', id: '1', output: 'x'.repeat(5000) });
      return { exitCode: 0, result: result() };
    };
    const code = await runCommand(['inspect'], { outputFormat: 'stream-json', quiet: true }, io, fake);
    expect(code).toBe(0);
    const lines = io.out().trim().split('\n').map(line => JSON.parse(line));
    expect(lines[0].type).toBe('run_start');
    expect(lines.at(-1)).toMatchObject({ type: 'result', ok: true });
    expect(lines.some(line => line.type === 'token_delta')).toBe(false);
    const tool = lines.find(line => line.type === 'tool_result');
    expect(tool.truncated).toBe(true);
    expect(Buffer.byteLength(tool.output, 'utf8')).toBeLessThanOrEqual(4096);
    expect(io.err()).toBe('');
  });

  it.each([
    [1, 'error'],
    [3, 'error'],
    [4, 'timeout'],
  ] as const)('preserves executor exit code %s in structured output', async (exitCode, stopReason) => {
    const io = captureIo();
    const fake = vi.fn(async (): Promise<HarnessRunExecution> => ({
      exitCode,
      result: result({ ok: false, stopReason, error: 'failed' }),
    }));
    const code = await runCommand(['work'], { outputFormat: 'json' }, io, fake);
    expect(code).toBe(exitCode);
    expect(JSON.parse(io.out())).toMatchObject({ ok: false, stopReason, error: 'failed' });
  });

  const partialRun = (): HarnessRunResult => result({
    verification: {
      coverageStatus: 'partial',
      scans: [{
        tool: 'run_security_suite',
        toolCallId: 'tc_1',
        coverage: {
          status: 'partial',
          scanners: [{ id: 'builtin', status: 'completed' }, { id: 'semgrep', status: 'missing' }],
          exclusions: [],
          deferred: ['Semgrep: missing'],
          notes: [],
        },
      }],
      fixRecords: [{
        recordHash: 'a'.repeat(64),
        path: '/records/aaa.json',
        executor: 'codex',
        assurance: 'scan-and-checks',
        verified: true,
        coverage: { before: 'partial', after: 'partial' },
      }],
    },
  });

  it('carries coverage and the fix record into json output', async () => {
    const io = captureIo();
    const fake = vi.fn(async (): Promise<HarnessRunExecution> => ({ exitCode: 0, result: partialRun() }));
    const code = await runCommand(['scan'], { outputFormat: 'json' }, io, fake);

    // The point of the whole field: a CI job reading this run's zero findings
    // can see that half the engines never ran.
    expect(code).toBe(0);
    const parsed = JSON.parse(io.out());
    expect(parsed.verification.coverageStatus).toBe('partial');
    expect(parsed.verification.scans[0].coverage.deferred).toEqual(['Semgrep: missing']);
    expect(parsed.verification.fixRecords[0].path).toBe('/records/aaa.json');
  });

  it('carries coverage into the stream-json result line', async () => {
    const io = captureIo();
    const fake = vi.fn(async (): Promise<HarnessRunExecution> => ({ exitCode: 0, result: partialRun() }));
    await runCommand(['scan'], { outputFormat: 'stream-json', quiet: true }, io, fake);

    const last = JSON.parse(io.out().trim().split('\n').at(-1)!);
    expect(last).toMatchObject({ type: 'result' });
    expect(last.verification.coverageStatus).toBe('partial');
  });

  it('states coverage and how to re-derive the record in text output', async () => {
    const io = captureIo();
    const fake = vi.fn(async (): Promise<HarnessRunExecution> => ({ exitCode: 0, result: partialRun() }));
    await runCommand(['scan'], { outputFormat: 'text', quiet: true }, io, fake);

    expect(io.out()).toContain('Scan coverage: partial');
    expect(io.out()).toContain('deferred: Semgrep: missing');
    expect(io.out()).toContain('security verify-fix /records/aaa.json');
  });

  it('says nothing about coverage when the run did no scanning', async () => {
    const io = captureIo();
    const fake = vi.fn(async (): Promise<HarnessRunExecution> => ({ exitCode: 0, result: result() }));
    await runCommand(['write a readme'], { outputFormat: 'json' }, io, fake);

    // Absent rather than `unknown`: an ordinary coding turn did not fail to
    // determine coverage, it had no scan to determine coverage for.
    expect(JSON.parse(io.out()).verification).toBeUndefined();
    expect(io.out()).not.toContain('coverage');
  });
});

describe('headless run validation and unattended policy', () => {
  it('classifies an unknown session as usage exit 2', async () => {
    const cwd = tempDir();
    process.env.DVALINCODE_POLICY_FILE = path.join(cwd, 'absent-policy.json');
    process.env.DVALINCODE_SESSIONS_DIR = path.join(cwd, 'sessions');
    const execution = await executeHarnessRun({ content: 'hello', cwd, sessionId: 'missing' });
    expect(execution.exitCode).toBe(2);
    expect(execution.result.error).toMatch(/Session not found/);
  });

  it('rejects an explicit permission mode above the unattended policy ceiling', async () => {
    const cwd = tempDir();
    process.env.DVALINCODE_POLICY_FILE = path.join(cwd, 'absent-machine-policy.json');
    writeFileSync(path.join(cwd, 'dvalin.policy.json'), JSON.stringify({
      unattended: { maxPermissionMode: 'auto' },
    }));
    const execution = await executeHarnessRun({
      content: 'hello', cwd, permissionMode: 'bypass', unattended: true,
    });
    expect(execution.exitCode).toBe(3);
    expect(execution.result.error).toMatch(/ceiling "auto"/);
  });
});
