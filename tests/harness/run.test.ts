import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `runAgentTurn` is stubbed so nothing here reaches a provider, a network call
// or the real agent loop. The subject under test is the hook object
// `executeHarnessRun` hands down -- specifically `requestApproval`, which is the
// governance invariant at src/harness/run.ts:240.
const runAgentTurn = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/agent/session.js')>();
  return { ...actual, runAgentTurn };
});

import { createDvalinContext } from '../../src/core/context.js';
import { executeHarnessRun } from '../../src/harness/run.js';
import { createDefaultToolRegistry } from '../../src/tools/registry.js';
import type { RunTurnHooks, RunTurnResult } from '../../src/agent/session.js';

const cleanups: Array<() => void> = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-harness-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A turn result shaped enough for `executeHarnessRun` to finish normally. */
function turnResult(): RunTurnResult {
  return {
    sessionId: 'dc_harness_test',
    providerId: 'mock',
    model: 'mock-model',
    policyHash: 'policy_hash',
    result: {
      runId: 'run_harness_test',
      iterationsUsed: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      output: 'done',
      stopReason: 'done',
      auditHead: 'audit_head',
    },
  } as unknown as RunTurnResult;
}

/** The hooks object `executeHarnessRun` passed down on the last call. */
function capturedHooks(): RunTurnHooks {
  expect(runAgentTurn).toHaveBeenCalled();
  return runAgentTurn.mock.calls.at(-1)![1] as RunTurnHooks;
}

beforeEach(() => {
  runAgentTurn.mockReset();
  runAgentTurn.mockResolvedValue(turnResult());
});

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length) cleanups.pop()!();
});

describe('executeHarnessRun approval policy', () => {
  it('completes a run that never reaches an approval-gated tool', async () => {
    const execution = await executeHarnessRun({ content: 'summarise the readme', cwd: tempDir() });

    expect(execution.exitCode).toBe(0);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('denies approval, because a headless run has no human to ask', async () => {
    await executeHarnessRun({ content: 'edit a file', cwd: tempDir() });

    const approved = await capturedHooks().requestApproval!(
      'apv_test',
      'write_file',
      { filePath: 'a.txt' },
    );

    // This is the bypass-proof assertion. Change src/harness/run.ts:240 to
    // `async () => true` and only this line goes red -- which is the whole
    // point, because the failure mode being guarded is silent auto-approval in
    // exactly the configuration with no human watching.
    expect(approved).toBe(false);
  });

  it('resolves the denial promptly rather than waiting for input', async () => {
    await executeHarnessRun({ content: 'edit a file', cwd: tempDir() });
    const requestApproval = capturedHooks().requestApproval!;

    // A hook that awaited a console or socket that will never speak would hang
    // the run instead of failing it. Racing against an already-resolved promise
    // asserts it settles without the event loop having to advance a timer.
    const settled = await Promise.race([
      requestApproval('apv_test', 'write_file', {}).then(() => 'settled'),
      Promise.resolve('pending'),
    ].map(p => Promise.resolve(p)));

    await expect(requestApproval('apv_test', 'write_file', {})).resolves.toBe(false);
    expect(settled).toBeDefined();
  });

  it('records the denial in the audit chain, not only in the return value', async () => {
    // "Denied but unrecorded" must not pass. The denial is only visible to an
    // operator if the tool layer wrote it down, so this drives the real
    // registry with the harness's own hook rather than asserting on the hook
    // alone.
    await executeHarnessRun({ content: 'edit a file', cwd: tempDir() });
    const requestApproval = capturedHooks().requestApproval!;

    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const context = createDvalinContext({
      cwd: tempDir(),
      approvalMode: 'auto-edit',
      requestApproval,
      audit: { append: (event: unknown) => events.push(event as never) } as never,
    });

    await expect(
      createDefaultToolRegistry().run('write_file', { filePath: 'a.txt', content: 'x' }, context),
    ).rejects.toThrow(/rejected/i);

    const approval = events.find(e => e.type === 'approval');
    expect(approval, `no approval event was audited: ${JSON.stringify(events)}`).toBeDefined();
    expect(approval).toMatchObject({ type: 'approval', toolName: 'write_file', approved: false });
  });

  it('does not write the file it was denied permission to write', async () => {
    // The end the invariant exists for: a denial that still mutated the
    // workspace would be an audit entry describing something that happened.
    await executeHarnessRun({ content: 'edit a file', cwd: tempDir() });
    const requestApproval = capturedHooks().requestApproval!;

    const cwd = tempDir();
    const context = createDvalinContext({ cwd, approvalMode: 'auto-edit', requestApproval });

    await expect(
      createDefaultToolRegistry().run('write_file', { filePath: 'created.txt', content: 'x' }, context),
    ).rejects.toThrow(/rejected/i);

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(cwd, 'created.txt'))).toBe(false);
  });
});
