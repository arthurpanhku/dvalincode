import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Stubbed so the end-to-end block below reaches no provider, network, or agent
// loop. What it exercises is the wiring in `executeHarnessRun` -- that the
// collector is begun, fed every event, and collected on the way out.
const runAgentTurn = vi.hoisted(() => vi.fn());
vi.mock('../../src/agent/session.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/agent/session.js')>();
  return { ...actual, runAgentTurn };
});

import { executeHarnessRun } from '../../src/harness/run.js';
import { createVerificationCollector } from '../../src/harness/verification.js';
import { buildFixRecord } from '../../src/security/fixRecord.js';
import { saveFixRecord } from '../../src/security/fixRecordStore.js';
import { securityProjectId, type SecurityCoverage, type SecurityCoverageStatus } from '../../src/security/contracts.js';
import type { AgentEvent } from '../../src/agent/types.js';

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function coverage(status: SecurityCoverageStatus, deferred: string[] = []): SecurityCoverage {
  return {
    status,
    scanners: [{ id: 'builtin', status: status === 'complete' ? 'completed' : 'missing' }],
    exclusions: [],
    deferred,
    notes: [],
  };
}

/** A tool_result carrying whatever a tool put in `metadata`. */
function toolResult(metadata: Record<string, unknown>, name = 'run_security_suite'): AgentEvent {
  return { type: 'tool_result', name, id: 'tc_1', output: 'ok', metadata };
}

/** A record that re-derives, so `listFixRecords` will not skip it. */
function record(projectRoot: string, options: { before?: SecurityCoverageStatus; after?: SecurityCoverageStatus; at?: string } = {}) {
  return buildFixRecord({
    projectId: securityProjectId(projectRoot),
    executor: 'codex',
    before: {
      scanId: 'scan_before',
      completedAt: '2026-09-03T00:00:00.000Z',
      coverage: coverage(options.before ?? 'complete'),
      targets: [],
    },
    after: {
      scanId: 'scan_after',
      completedAt: '2026-09-03T00:01:00.000Z',
      coverage: coverage(options.after ?? 'complete'),
      remainingTargets: [],
    },
    checks: [],
    generatedAt: options.at ?? '2026-09-03T00:02:00.000Z',
  });
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('harness verification collector', () => {
  let store: string;
  let cwd: string;

  beforeEach(() => {
    store = tempDir('dvalin-fixrecords-');
    cwd = tempDir('dvalin-workspace-');
  });

  const collector = () => createVerificationCollector(cwd, () => store);

  it('reports nothing when the turn neither scanned nor filed a record', () => {
    const subject = collector();
    subject.begin();
    subject.observe({ type: 'llm_iteration', iteration: 1 });

    // Absent, not `unknown`. A caller must be able to tell "no scan happened"
    // from "a scan could not say what it looked at" -- collapsing the two is
    // the failure this field exists to prevent.
    expect(subject.collect()).toBeUndefined();
  });

  it('carries the coverage a scan tool reported', () => {
    const subject = collector();
    subject.begin();
    subject.observe(toolResult({ coverage: coverage('partial', ['semgrep: missing']) }));

    const result = subject.collect();
    expect(result?.coverageStatus).toBe('partial');
    expect(result?.scans).toHaveLength(1);
    expect(result?.scans[0]).toMatchObject({ tool: 'run_security_suite', toolCallId: 'tc_1' });
    expect(result?.scans[0]?.coverage.deferred).toEqual(['semgrep: missing']);
  });

  it('reports the weakest coverage across several scans, not the last or the best', () => {
    const subject = collector();
    subject.begin();
    subject.observe(toolResult({ coverage: coverage('partial') }));
    subject.observe(toolResult({ coverage: coverage('complete') }));

    // A later complete scan must not speak for the earlier partial one.
    expect(subject.collect()?.coverageStatus).toBe('partial');
    expect(subject.collect()?.scans).toHaveLength(2);
  });

  it('treats unknown as weaker than partial', () => {
    const subject = collector();
    subject.begin();
    subject.observe(toolResult({ coverage: coverage('partial') }));
    subject.observe(toolResult({ coverage: coverage('unknown') }));

    expect(subject.collect()?.coverageStatus).toBe('unknown');
  });

  it('drops malformed coverage rather than reporting a status it did not read', () => {
    const subject = collector();
    subject.begin();
    subject.observe(toolResult({ coverage: { status: 'mostly-fine' } }));
    subject.observe(toolResult({ coverage: 'complete' }));
    subject.observe(toolResult({ cases: [] }));

    expect(subject.collect()).toBeUndefined();
  });

  it('credits the run only with records filed after it began', () => {
    const before = record(cwd, { at: '2026-09-02T00:00:00.000Z' });
    saveFixRecord(before, store);

    const subject = collector();
    subject.begin();
    const during = record(cwd, { at: '2026-09-03T12:00:00.000Z' });
    saveFixRecord(during, store);

    const result = subject.collect();
    expect(result?.fixRecords.map(entry => entry.recordHash)).toEqual([during.recordHash]);
    expect(result?.fixRecords[0]).toMatchObject({
      executor: 'codex',
      assurance: 'scan-only',
      path: path.join(store, `${during.recordHash}.json`),
    });
  });

  it('ignores records belonging to another workspace', () => {
    const other = tempDir('dvalin-other-workspace-');
    const subject = collector();
    subject.begin();
    saveFixRecord(record(other), store);

    // The store is install-global; another project's record is someone else's
    // file paths and rule ids, and is not evidence about this run.
    expect(subject.collect()).toBeUndefined();
  });

  it("folds a record's own coverage into the headline status", () => {
    const subject = collector();
    subject.begin();
    saveFixRecord(record(cwd, { after: 'partial' }), store);

    // The scan behind a record counts too: a repair verified against a
    // half-blind rescan is exactly the case a gate must not read as clean.
    expect(subject.collect()?.coverageStatus).toBe('partial');
  });

  it('reports scans even when begin() was never called', () => {
    const subject = createVerificationCollector(cwd, () => store);
    saveFixRecord(record(cwd), store);
    subject.observe(toolResult({ coverage: coverage('complete') }));

    // Without a starting point every record on disk would look new, so records
    // are withheld -- but what the turn itself reported still stands.
    const result = subject.collect();
    expect(result?.scans).toHaveLength(1);
    expect(result?.fixRecords).toEqual([]);
  });

  it('survives a fix-record store that does not exist', () => {
    const subject = createVerificationCollector(cwd, () => path.join(store, 'absent'));
    subject.begin();
    subject.observe(toolResult({ coverage: coverage('complete') }));

    expect(subject.collect()?.coverageStatus).toBe('complete');
  });
});

describe('executeHarnessRun carries verification into its result', () => {
  let store: string;
  let cwd: string;

  beforeEach(() => {
    store = tempDir('dvalin-e2e-records-');
    cwd = tempDir('dvalin-e2e-workspace-');
    process.env.DVALINCODE_FIX_RECORD_DIR = store;
    process.env.DVALINCODE_POLICY_FILE = path.join(cwd, 'absent-policy.json');
    process.env.DVALINCODE_SESSIONS_DIR = path.join(cwd, 'sessions');
    runAgentTurn.mockReset();
  });

  afterEach(() => {
    delete process.env.DVALINCODE_FIX_RECORD_DIR;
    delete process.env.DVALINCODE_POLICY_FILE;
    delete process.env.DVALINCODE_SESSIONS_DIR;
  });

  /** A turn that emits the given events, then finishes normally. */
  function turnEmitting(...events: AgentEvent[]) {
    return async (_request: unknown, hooks: { onEvent?: (event: AgentEvent) => void }) => {
      for (const event of events) hooks.onEvent?.(event);
      return {
        sessionId: 'dc_e2e',
        providerId: 'mock',
        model: 'mock-model',
        policyHash: 'policy',
        result: {
          runId: 'run_e2e',
          iterationsUsed: 1,
          usage: { inputTokens: 1, outputTokens: 1 },
          output: 'done',
          stopReason: 'done',
          auditHead: 'head',
        },
      };
    };
  }

  it('reports the coverage a scan tool emitted during the turn', async () => {
    runAgentTurn.mockImplementation(turnEmitting(toolResult({ coverage: coverage('partial', ['Semgrep: missing']) })));

    const execution = await executeHarnessRun({ content: 'scan this repo', cwd });

    expect(execution.exitCode).toBe(0);
    expect(execution.result.verification?.coverageStatus).toBe('partial');
    expect(execution.result.verification?.scans[0]?.coverage.deferred).toEqual(['Semgrep: missing']);
  });

  it('reports a fix record the turn filed, with a path that re-derives it', async () => {
    const filed = record(cwd);
    runAgentTurn.mockImplementation(async (_request: unknown, hooks: { onEvent?: (event: AgentEvent) => void }) => {
      // Stands in for the agent shelling out to `dvalin verify`, which files the
      // record under its own audit run -- there is no run id to join on.
      saveFixRecord(filed, store);
      return turnEmitting()(_request, hooks);
    });

    const execution = await executeHarnessRun({ content: 'fix and verify', cwd });

    const reported = execution.result.verification?.fixRecords ?? [];
    expect(reported.map(entry => entry.recordHash)).toEqual([filed.recordHash]);
    expect(reported[0]?.path).toBe(path.join(store, `${filed.recordHash}.json`));
  });

  it('still reports coverage when the turn failed after scanning', async () => {
    runAgentTurn.mockImplementation(async (_request: unknown, hooks: { onEvent?: (event: AgentEvent) => void }) => {
      hooks.onEvent?.(toolResult({ coverage: coverage('unknown') }));
      throw new Error('provider exploded');
    });

    const execution = await executeHarnessRun({ content: 'scan this repo', cwd });

    // A run that scanned and then died still learned something about coverage.
    expect(execution.exitCode).toBe(1);
    expect(execution.result.verification?.coverageStatus).toBe('unknown');
  });

  it('leaves the exit code alone when coverage is partial', async () => {
    runAgentTurn.mockImplementation(turnEmitting(toolResult({ coverage: coverage('partial') })));

    const execution = await executeHarnessRun({ content: 'scan this repo', cwd });

    // Deliberate, and the one decision here that touches an external contract:
    // coverage describes the scan, not the run. A turn that completed its task
    // with a half-blind scanner did not fail, and folding this into the process
    // exit would silently redefine exit 0 for every existing consumer.
    expect(execution.exitCode).toBe(0);
    expect(execution.result.ok).toBe(true);
  });

  it('omits the field entirely for a turn that never scanned', async () => {
    runAgentTurn.mockImplementation(turnEmitting({ type: 'llm_iteration', iteration: 1 }));

    const execution = await executeHarnessRun({ content: 'write a readme', cwd });

    expect(execution.result.verification).toBeUndefined();
  });
});
