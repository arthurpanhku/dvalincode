import { readdirSync } from 'node:fs';
import path from 'node:path';

import type { AgentEvent } from '../agent/types.js';
import {
  SECURITY_COVERAGE_STATUSES,
  securityProjectId,
  type SecurityCoverage,
  type SecurityCoverageStatus,
} from '../security/contracts.js';
import type { VerifiedFixRecord } from '../security/fixRecord.js';
import { defaultFixRecordDir, listFixRecords } from '../security/fixRecordStore.js';

/**
 * What a headless run can say about the scanning it did.
 *
 * Every surface a human watches now shows coverage. This is the one with no
 * human present, which makes it the one where a silent omission does the most
 * damage: a CI gate reading "no findings" from a run where half the engines
 * were missing is the machine-readable form of the bug the rest of this work
 * closed.
 */

/** One security scan performed during the turn, with what it actually covered. */
export type HarnessScanCoverage = {
  /** The tool that ran the scan, e.g. `run_security_suite`. */
  tool: string;
  toolCallId: string;
  coverage: SecurityCoverage;
};

/**
 * A Verified Fix Record filed during the turn.
 *
 * The record itself is not inlined — it is already a portable file, and
 * `path` is what a consumer feeds to `dvalincode security verify-fix` to
 * re-derive the verdict offline without re-running the agent.
 */
export type HarnessFixRecordRef = {
  recordHash: string;
  path: string;
  /** Who edited the code. Recorded here as it is in the record: never consulted. */
  executor: string;
  assurance: VerifiedFixRecord['assurance'];
  verified: boolean;
  coverage: { before: SecurityCoverageStatus; after: SecurityCoverageStatus };
};

export type HarnessVerification = {
  /**
   * The weakest coverage this run has evidence of, across every scan it ran and
   * every record it filed. The single field a CI gate should read: taking the
   * best or the last would let one complete scan speak for a partial one.
   */
  coverageStatus: SecurityCoverageStatus;
  scans: HarnessScanCoverage[];
  fixRecords: HarnessFixRecordRef[];
};

export type VerificationCollector = {
  /** Note which records already existed, so the run is credited only with what it filed. */
  begin(): void;
  observe(event: AgentEvent): void;
  /** `undefined` when the turn neither scanned nor filed a record — see below. */
  collect(): HarnessVerification | undefined;
};

/** `unknown` is weaker than `partial`: not knowing what ran is worse than knowing it was incomplete. */
const COVERAGE_RANK: Record<SecurityCoverageStatus, number> = { unknown: 0, partial: 1, complete: 2 };

function isCoverageStatus(value: unknown): value is SecurityCoverageStatus {
  return typeof value === 'string' && (SECURITY_COVERAGE_STATUSES as readonly string[]).includes(value);
}

/**
 * Tool metadata is `Record<string, unknown>` by the time it reaches an event, so
 * it is validated rather than cast. A malformed `coverage` is dropped: reporting
 * a status this did not actually read would be the same failure one level up.
 */
function asCoverage(value: unknown): SecurityCoverage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<SecurityCoverage>;
  if (!isCoverageStatus(candidate.status)) return undefined;
  if (!Array.isArray(candidate.scanners)) return undefined;
  if (!Array.isArray(candidate.exclusions) || !Array.isArray(candidate.deferred) || !Array.isArray(candidate.notes)) {
    return undefined;
  }
  return candidate as SecurityCoverage;
}

/**
 * Hashes of the records already on disk.
 *
 * Read from filenames rather than by parsing: `saveFixRecord` names every file
 * after the record's own hash, so the directory listing is the hash set, and a
 * store with thousands of records costs one readdir instead of thousands of
 * re-derivations.
 */
function existingRecordHashes(dir: string): Set<string> {
  try {
    return new Set(
      readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .map(name => name.slice(0, -'.json'.length)),
    );
  } catch {
    // No store yet, or unreadable. Either way nothing pre-existed that this run
    // could be wrongly credited with.
    return new Set();
  }
}

export function createVerificationCollector(
  cwd: string,
  resolveDir: () => string = defaultFixRecordDir,
): VerificationCollector {
  const scans: HarnessScanCoverage[] = [];
  let known = new Set<string>();
  let begun = false;

  return {
    begin() {
      known = existingRecordHashes(resolveDir());
      begun = true;
    },

    observe(event) {
      if (event.type !== 'tool_result') return;
      const coverage = asCoverage(event.metadata?.coverage);
      if (coverage) scans.push({ tool: event.name, toolCallId: event.id, coverage });
    },

    collect() {
      const dir = resolveDir();
      // Without a starting point every record in the store would look new, so a
      // collector that was never begun reports scans only.
      const filed = begun
        ? listFixRecords(dir, { projectId: securityProjectId(cwd) }).filter(
            record => !known.has(record.recordHash),
          )
        : [];

      if (!scans.length && !filed.length) return undefined;

      const fixRecords: HarnessFixRecordRef[] = filed.map(record => ({
        recordHash: record.recordHash,
        path: path.join(dir, `${record.recordHash}.json`),
        executor: record.executor,
        assurance: record.assurance,
        verified: record.verdict.verified,
        coverage: { before: record.before.coverage.status, after: record.after.coverage.status },
      }));

      const statuses: SecurityCoverageStatus[] = [
        ...scans.map(scan => scan.coverage.status),
        ...fixRecords.flatMap(record => [record.coverage.before, record.coverage.after]),
      ];
      const coverageStatus = statuses.reduce(
        (weakest, status) => (COVERAGE_RANK[status] < COVERAGE_RANK[weakest] ? status : weakest),
        'complete' as SecurityCoverageStatus,
      );

      return { coverageStatus, scans, fixRecords };
    },
  };
}
