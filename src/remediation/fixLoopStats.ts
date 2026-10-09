import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultFixLoopDir, type FixLoopLog, type FixLoopOutcome } from './fixLoop.js';

/**
 * What the round logs say about the fix loop, across every run on this machine.
 *
 * The loop's stop rules and feedback are tuned on this, and it is the only
 * honest answer to "does it work?": how often a loop reaches green, in how many
 * rounds, and — when it does not — what was still open when it stopped. Each
 * number is derived from logs alone, so the summary can be re-derived by anyone
 * holding the same files.
 */
export type FixLoopStats = {
  dir: string;
  loops: number;
  /** Files in the directory that are not loop logs, or not readable as one. */
  unreadable: string[];
  /** Earliest and latest loop start among those counted. */
  window: { from: string | null; to: string | null };
  outcomes: Partial<Record<FixLoopOutcome, number>>;
  /** Verified loops over loops that attempted a fix (excludes not-auto-fixable). */
  verifiedRate: number | null;
  /** Fix rounds a verified loop took. Reproduce rounds are not counted. */
  roundsToGreen: Distribution | null;
  /** Which stop rule fired; v1 logs did not record it and count as `unknown`. */
  stopRules: Record<string, number>;
  /**
   * For loops that stopped short (stalled or budget-exhausted): how many still
   * had each kind of problem open in their last fix round. One loop can count
   * under several.
   */
  openAtStop: { loops: number; targets: number; introduced: number; failedChecks: number; suppressions: number; evasion: number };
  /** Loops where any fix round was judged to hide a finding rather than fix it. */
  evasionLoops: number;
  /** Loops where the executor added a suppression in any fix round. */
  suppressionLoops: number;
  reproduction: Record<string, number>;
  rebasedLoops: number;
  needsHuman: number;
  /** Wall time spent in rounds, per loop. */
  durationMs: Distribution | null;
  /**
   * Scan time per fix round, split by how the round was scanned. Logs written
   * before rounds recorded their scan are not counted here.
   */
  scanMs: { narrowed: Distribution | null; full: Distribution | null };
  /**
   * Narrowed rounds that would have stopped, re-judged on a full scan; and how
   * many of those the full scan decided differently.
   */
  confirmations: { total: number; changedDecision: number };
  byExecutor: Record<string, { loops: number; verified: number; roundsToGreen: Distribution | null }>;
};

export type Distribution = { median: number; p90: number; max: number; histogram: Record<string, number> };

export type FixLoopStatsFilter = {
  /** Only loops started at or after this time. */
  since?: Date;
  executor?: string;
};

export async function readFixLoopLogs(dir = defaultFixLoopDir()): Promise<{ logs: FixLoopLog[]; unreadable: string[] }> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    // No loop has run here yet: an empty history, not a failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { logs: [], unreadable: [] };
    throw error;
  }
  const logs: FixLoopLog[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as unknown;
      if (isLoopLog(parsed)) logs.push(parsed);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { logs, unreadable };
}

export function summarizeFixLoops(logs: FixLoopLog[], options: { dir: string; unreadable?: string[] } & FixLoopStatsFilter): FixLoopStats {
  const selected = logs.filter(log => {
    if (options.executor && (log.executor ?? 'unknown') !== options.executor) return false;
    if (options.since) {
      const started = loopStart(log);
      // A loop whose start cannot be told is not known to be in the window.
      if (!started || started < options.since) return false;
    }
    return true;
  });

  const outcomes: FixLoopStats['outcomes'] = {};
  const stopRules: Record<string, number> = {};
  const reproduction: Record<string, number> = {};
  const openAtStop = { loops: 0, targets: 0, introduced: 0, failedChecks: 0, suppressions: 0, evasion: 0 };
  const greenRounds: number[] = [];
  const durations: number[] = [];
  const scanNarrowed: number[] = [];
  const scanFull: number[] = [];
  const confirmations = { total: 0, changedDecision: 0 };
  const executors = new Map<string, { loops: number; verified: number; rounds: number[] }>();
  const starts: Date[] = [];
  let evasionLoops = 0;
  let suppressionLoops = 0;
  let rebasedLoops = 0;
  let needsHuman = 0;

  for (const log of selected) {
    bump(outcomes, log.outcome);
    bump(stopRules, log.stopRule ?? 'unknown');
    if (log.reproduction) bump(reproduction, log.reproduction);
    needsHuman += log.needsHuman.length;
    const start = loopStart(log);
    if (start) starts.push(start);

    const fixRounds = log.rounds.filter(round => round.phase === 'fix');
    if (fixRounds.some(round => round.evasion > 0)) evasionLoops += 1;
    if (fixRounds.some(round => round.suppressions > 0)) suppressionLoops += 1;
    if (log.rounds.some(round => round.rebased)) rebasedLoops += 1;
    if (log.rounds.length) durations.push(log.rounds.reduce((sum, round) => sum + round.durationMs, 0));
    for (const round of fixRounds) {
      if (!round.scan) continue;
      (round.scan.mode === 'narrowed' ? scanNarrowed : scanFull).push(round.scan.durationMs);
      if (round.scan.confirmed) {
        confirmations.total += 1;
        if (round.scan.decisionChanged) confirmations.changedDecision += 1;
      }
    }

    const executor = log.executor ?? 'unknown';
    const entry = executors.get(executor) ?? { loops: 0, verified: 0, rounds: [] };
    entry.loops += 1;
    if (log.outcome === 'verified') {
      entry.verified += 1;
      entry.rounds.push(fixRounds.length);
      greenRounds.push(fixRounds.length);
    }
    executors.set(executor, entry);

    const last = fixRounds.at(-1);
    if (last && (log.outcome === 'stalled' || log.outcome === 'budget-exhausted')) {
      openAtStop.loops += 1;
      if (last.remaining > 0) openAtStop.targets += 1;
      if (last.blockingIntroduced > 0) openAtStop.introduced += 1;
      if (last.failedChecks.length > 0) openAtStop.failedChecks += 1;
      if (last.suppressions > 0) openAtStop.suppressions += 1;
      if (last.evasion > 0) openAtStop.evasion += 1;
    }
  }

  const attempted = selected.length - (outcomes['not-auto-fixable'] ?? 0);
  starts.sort((a, b) => a.getTime() - b.getTime());
  return {
    dir: options.dir,
    loops: selected.length,
    unreadable: options.unreadable ?? [],
    window: { from: starts[0]?.toISOString() ?? null, to: starts.at(-1)?.toISOString() ?? null },
    outcomes,
    verifiedRate: attempted > 0 ? (outcomes.verified ?? 0) / attempted : null,
    roundsToGreen: distribution(greenRounds),
    stopRules,
    openAtStop,
    evasionLoops,
    suppressionLoops,
    reproduction,
    rebasedLoops,
    needsHuman,
    durationMs: distribution(durations, false),
    scanMs: { narrowed: distribution(scanNarrowed, false), full: distribution(scanFull, false) },
    confirmations,
    byExecutor: Object.fromEntries([...executors].sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => [
      name,
      { loops: entry.loops, verified: entry.verified, roundsToGreen: distribution(entry.rounds) },
    ])),
  };
}

export function renderFixLoopStats(stats: FixLoopStats): string {
  const lines = [`Fix loops: ${stats.loops} in ${stats.dir}`];
  if (stats.unreadable.length) lines.push(`Skipped ${stats.unreadable.length} file(s) that are not loop logs: ${stats.unreadable.join(', ')}`);
  if (!stats.loops) {
    lines.push('No loop has been logged yet. Run `dvalincode dvalin --fix --until-clean` to start one.');
    return lines.join('\n');
  }
  if (stats.window.from) lines.push(`Window: ${stats.window.from} → ${stats.window.to}`);
  lines.push('', 'Outcomes:');
  for (const [outcome, count] of sortedEntries(stats.outcomes)) lines.push(`  ${outcome.padEnd(18)} ${count}`);
  if (stats.verifiedRate !== null) lines.push(`Verified: ${percent(stats.verifiedRate)} of loops that attempted a fix`);
  if (stats.roundsToGreen) {
    lines.push(`Rounds to green: median ${stats.roundsToGreen.median}, p90 ${stats.roundsToGreen.p90}, max ${stats.roundsToGreen.max}`);
    lines.push(`  ${Object.entries(stats.roundsToGreen.histogram).map(([rounds, count]) => `${rounds}: ${count}`).join(' · ')}`);
  }
  lines.push('', 'Stop rules:');
  for (const [rule, count] of sortedEntries(stats.stopRules)) lines.push(`  ${rule.padEnd(18)} ${count}`);
  if (stats.openAtStop.loops) {
    const open = stats.openAtStop;
    lines.push('', `Still open when ${open.loops} loop(s) stalled or ran out of rounds:`);
    lines.push(`  targets not closed  ${open.targets}`);
    lines.push(`  introduced findings ${open.introduced}`);
    lines.push(`  failing checks      ${open.failedChecks}`);
    lines.push(`  added suppressions  ${open.suppressions}`);
    lines.push(`  evasion signals     ${open.evasion}`);
  }
  lines.push('', `Judged evasion in some round: ${stats.evasionLoops} loop(s); added a suppression: ${stats.suppressionLoops}; rebased: ${stats.rebasedLoops}`);
  if (Object.keys(stats.reproduction).length) {
    lines.push(`Reproduction: ${sortedEntries(stats.reproduction).map(([status, count]) => `${status} ${count}`).join(', ')}`);
  }
  if (stats.needsHuman) lines.push(`Targets handed to a person: ${stats.needsHuman}`);
  if (stats.durationMs) lines.push(`Time in rounds per loop: median ${seconds(stats.durationMs.median)}, p90 ${seconds(stats.durationMs.p90)}`);
  const { narrowed, full } = stats.scanMs ?? { narrowed: null, full: null };
  if (narrowed || full) {
    const part = (label: string, d: Distribution | null) => d ? `${label} median ${seconds(d.median)}, p90 ${seconds(d.p90)}` : undefined;
    lines.push(`Scan time per round: ${[part('narrowed', narrowed), part('full', full)].filter(Boolean).join(' · ')}`);
  }
  if (stats.confirmations?.total) {
    lines.push(`Stops confirmed by a full scan: ${stats.confirmations.total}, decision changed by it: ${stats.confirmations.changedDecision}`);
  }
  if (Object.keys(stats.byExecutor).length > 1) {
    lines.push('', 'By executor:');
    for (const [name, entry] of Object.entries(stats.byExecutor)) {
      const green = entry.roundsToGreen ? `, median ${entry.roundsToGreen.median} round(s) to green` : '';
      lines.push(`  ${name.padEnd(12)} ${entry.verified}/${entry.loops} verified${green}`);
    }
  }
  return lines.join('\n');
}

function isLoopLog(value: unknown): value is FixLoopLog {
  if (!value || typeof value !== 'object') return false;
  const log = value as Partial<FixLoopLog>;
  return log.kind === 'dvalin-fix-loop'
    && typeof log.id === 'string'
    && typeof log.outcome === 'string'
    && Array.isArray(log.rounds)
    && log.rounds.every(round => round && typeof round === 'object' && typeof round.durationMs === 'number')
    && Array.isArray(log.needsHuman);
}

/** v2 logs carry `startedAt`; v1 logs only have it inside their id. */
export function loopStart(log: Pick<FixLoopLog, 'id' | 'startedAt'>): Date | undefined {
  if (log.startedAt) {
    const parsed = new Date(log.startedAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const match = /^fixloop-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(log.id);
  if (!match) return undefined;
  const parsed = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function distribution(values: number[], histogram = true): Distribution | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const counts: Record<string, number> = {};
  if (histogram) for (const value of sorted) bump(counts, String(value));
  return { median: quantile(sorted, 0.5), p90: quantile(sorted, 0.9), max: sorted.at(-1)!, histogram: counts };
}

/** Nearest-rank, so every reported value is one a real loop produced. */
function quantile(sorted: number[], q: number): number {
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedEntries(counts: Record<string, number | undefined>): Array<[string, number]> {
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
