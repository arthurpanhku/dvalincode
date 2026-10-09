import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FixLoopLog, FixLoopRound } from '../src/remediation/fixLoop.js';
import { loopStart, readFixLoopLogs, renderFixLoopStats, summarizeFixLoops } from '../src/remediation/fixLoopStats.js';
import { buildDvalinProgram } from '../src/dvalinCli.js';

let dir: string;

function round(overrides: Partial<FixLoopRound> = {}): FixLoopRound {
  return {
    phase: 'fix',
    round: 1,
    durationMs: 1000,
    remaining: 0,
    blockingIntroduced: 0,
    failedChecks: [],
    suppressions: 0,
    evasion: 0,
    open: 0,
    fixed: 1,
    ...overrides,
  };
}

function log(id: string, overrides: Partial<FixLoopLog> = {}): FixLoopLog {
  return {
    kind: 'dvalin-fix-loop',
    schemaVersion: 2,
    id: `fixloop-2026-10-0${id}T10-00-00-000Z-0000000${id}`,
    startedAt: `2026-10-0${id}T10:00:00.000Z`,
    executor: 'dvalin',
    outcome: 'verified',
    stopRule: 'clean',
    reason: 'every target is gone',
    rounds: [round()],
    needsHuman: [],
    reproduction: null,
    evasion: [],
    recordHash: null,
    ...overrides,
  };
}

function save(entry: unknown, name = `${(entry as FixLoopLog).id}.json`): void {
  writeFileSync(path.join(dir, name), JSON.stringify(entry));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'dvalin-loopstats-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('fix loop statistics', () => {
  it('splits scan time by how rounds were scanned and counts full-scan confirmations', () => {
    const stats = summarizeFixLoops([
      log('1', {
        rounds: [
          round({ round: 1, scan: { mode: 'narrowed', durationMs: 2000, confirmed: true, decisionChanged: true } }),
          round({ round: 2, scan: { mode: 'narrowed', durationMs: 4000, confirmed: true, decisionChanged: false } }),
        ],
      }),
      log('2', { rounds: [round({ scan: { mode: 'full', durationMs: 9000 } })] }),
      // Written before rounds recorded their scan: counted elsewhere, not here.
      log('3'),
    ], { dir });

    expect(stats.scanMs.narrowed).toMatchObject({ median: 2000, max: 4000 });
    expect(stats.scanMs.full).toMatchObject({ median: 9000 });
    expect(stats.confirmations).toEqual({ total: 2, changedDecision: 1 });
    const text = renderFixLoopStats(stats);
    expect(text).toContain('Scan time per round: narrowed median');
    expect(text).toContain('Stops confirmed by a full scan: 2, decision changed by it: 1');
  });

  it('reports rounds to green and where loops stopped short', () => {
    const logs = [
      log('1'),
      log('2', { rounds: [round({ remaining: 1, open: 1, fixed: 0 }), round({ round: 2 })] }),
      log('3', { executor: 'codex', rounds: [round(), round({ round: 2 }), round({ round: 3 })] }),
      log('4', {
        outcome: 'stalled',
        stopRule: 'oscillating',
        rounds: [round({ remaining: 1, open: 2, failedChecks: ['test'] }), round({ round: 2, remaining: 1, open: 2, suppressions: 1, evasion: 1 })],
      }),
      log('5', { outcome: 'not-auto-fixable', stopRule: 'nothing-fixable', rounds: [], needsHuman: [{ ruleId: 'r', reason: 'no fixed version' }] }),
    ];
    const stats = summarizeFixLoops(logs, { dir });
    expect(stats.loops).toBe(5);
    expect(stats.outcomes).toEqual({ verified: 3, stalled: 1, 'not-auto-fixable': 1 });
    // not-auto-fixable never attempted a fix, so it is not a failure of the loop.
    expect(stats.verifiedRate).toBe(0.75);
    expect(stats.roundsToGreen).toEqual({ median: 2, p90: 3, max: 3, histogram: { 1: 1, 2: 1, 3: 1 } });
    expect(stats.stopRules).toEqual({ clean: 3, oscillating: 1, 'nothing-fixable': 1 });
    // Only the last round counts: the failing check in round 1 was fixed.
    expect(stats.openAtStop).toEqual({ loops: 1, targets: 1, introduced: 0, failedChecks: 0, suppressions: 1, evasion: 1 });
    expect(stats.evasionLoops).toBe(1);
    expect(stats.suppressionLoops).toBe(1);
    expect(stats.needsHuman).toBe(1);
    expect(stats.byExecutor.codex).toMatchObject({ loops: 1, verified: 1 });
    expect(stats.byExecutor.dvalin).toMatchObject({ loops: 4, verified: 2 });
    expect(stats.window).toEqual({ from: '2026-10-01T10:00:00.000Z', to: '2026-10-05T10:00:00.000Z' });
  });

  it('does not count reproduce rounds as rounds to green', () => {
    const stats = summarizeFixLoops([
      log('1', { reproduction: 'reproduced', rounds: [round({ phase: 'reproduce' }), round({ phase: 'reproduce', round: 2 }), round()] }),
    ], { dir });
    expect(stats.roundsToGreen?.median).toBe(1);
    expect(stats.reproduction).toEqual({ reproduced: 1 });
  });

  it('reads version 1 logs, taking their start from the id and their stop rule as unknown', () => {
    const v1 = log('3', { schemaVersion: 1 });
    delete v1.startedAt;
    delete v1.executor;
    delete v1.stopRule;
    expect(loopStart(v1)?.toISOString()).toBe('2026-10-03T10:00:00.000Z');
    const stats = summarizeFixLoops([v1], { dir, since: new Date('2026-10-02') });
    expect(stats.loops).toBe(1);
    expect(stats.stopRules).toEqual({ unknown: 1 });
    expect(Object.keys(stats.byExecutor)).toEqual(['unknown']);
  });

  it('filters by start date and executor', () => {
    const logs = [log('1'), log('2', { executor: 'claude-code' }), log('3', { executor: 'claude-code' })];
    expect(summarizeFixLoops(logs, { dir, since: new Date('2026-10-02') }).loops).toBe(2);
    expect(summarizeFixLoops(logs, { dir, executor: 'claude-code', since: new Date('2026-10-03') }).loops).toBe(1);
  });

  it('skips files that are not loop logs instead of failing', async () => {
    save(log('1'));
    save({ kind: 'something-else' }, 'other.json');
    writeFileSync(path.join(dir, 'broken.json'), '{');
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const read = await readFixLoopLogs(dir);
    expect(read.logs.map(entry => entry.id)).toEqual([log('1').id]);
    expect(read.unreadable).toEqual(['broken.json', 'other.json']);
  });

  it('treats a directory no loop has written to as an empty history', async () => {
    expect(await readFixLoopLogs(path.join(dir, 'missing'))).toEqual({ logs: [], unreadable: [] });
    const text = renderFixLoopStats(summarizeFixLoops([], { dir }));
    expect(text).toContain('No loop has been logged yet');
  });

  it('renders the numbers a person tunes the loop on', () => {
    const text = renderFixLoopStats(summarizeFixLoops([
      log('1'),
      log('2', { outcome: 'budget-exhausted', stopRule: 'budget', rounds: [round({ remaining: 2, open: 2, blockingIntroduced: 1 })] }),
    ], { dir }));
    expect(text).toContain('Verified: 50% of loops that attempted a fix');
    expect(text).toContain('Rounds to green: median 1, p90 1, max 1');
    expect(text).toContain('Still open when 1 loop(s) stalled or ran out of rounds:');
    expect(text).toMatch(/introduced findings 1/);
  });
});

describe('dvalin loop-stats', () => {
  async function run(...args: string[]): Promise<string> {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value?: unknown) => { out.push(String(value)); });
    const program = buildDvalinProgram();
    program.exitOverride();
    for (const command of program.commands) command.exitOverride();
    await program.parseAsync(['node', 'dvalin', 'loop-stats', ...args]);
    return out.join('\n');
  }

  it('summarizes a log directory as JSON', async () => {
    mkdirSync(dir, { recursive: true });
    save(log('1'));
    save(log('2', { outcome: 'stalled', stopRule: 'no-change' }));
    const body = JSON.parse(await run('--dir', dir, '--json'));
    expect(body.loops).toBe(2);
    expect(body.outcomes).toEqual({ verified: 1, stalled: 1 });
    expect(body.schemaVersion).toBeTypeOf('number');
  });

  it('rejects a --since that is not a date and an unknown executor', async () => {
    await expect(run('--dir', dir, '--since', 'last tuesday')).rejects.toThrow('--since is not a date');
    await expect(run('--dir', dir, '--executor', 'robot')).rejects.toThrow('--executor must be one of');
  });
});
