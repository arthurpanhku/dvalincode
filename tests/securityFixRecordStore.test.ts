import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFixRecord, fixRecordHash } from '../src/security/fixRecord.js';
import { listFixRecords, saveFixRecord } from '../src/security/fixRecordStore.js';
import { buildEvidencePack, verifyEvidencePack } from '../src/evidence/pack.js';
import type { SecurityCoverage } from '../src/security/contracts.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const complete: SecurityCoverage = {
  status: 'complete',
  scanners: [{ id: 'builtin', status: 'completed' }],
  exclusions: [],
  deferred: [],
  notes: [],
};

function record(overrides: { generatedAt?: string; passing?: boolean } = {}) {
  return buildFixRecord({
    projectId: 'p1',
    executor: 'dvalin',
    before: { scanId: 'a', completedAt: '2026-01-01T00:00:00Z', coverage: complete, targets: [] },
    after: { scanId: 'b', completedAt: '2026-01-01T00:05:00Z', coverage: complete, remainingTargets: [] },
    checks: [{ kind: 'test', command: 'npm test', exitCode: overrides.passing === false ? 1 : 0, passed: overrides.passing !== false }],
    generatedAt: overrides.generatedAt ?? '2026-01-01T00:06:00Z',
    version: '0.18.0',
  });
}

describe('fix record store', () => {
  it('files a record under its own hash, so filing it twice is one file', () => {
    const dir = tempDir('dvalin-fix-store-');
    const one = record();

    expect(saveFixRecord(one, dir)).toContain(one.recordHash);
    saveFixRecord(one, dir);

    expect(readdirSync(dir)).toEqual([`${one.recordHash}.json`]);
  });

  it('returns records newest first', () => {
    const dir = tempDir('dvalin-fix-store-');
    saveFixRecord(record({ generatedAt: '2026-01-01T00:00:00Z' }), dir);
    saveFixRecord(record({ generatedAt: '2026-03-01T00:00:00Z' }), dir);

    expect(listFixRecords(dir).map(entry => entry.generatedAt))
      .toEqual(['2026-03-01T00:00:00Z', '2026-01-01T00:00:00Z']);
  });

  it('leaves out a record that no longer re-derives, rather than presenting it as evidence', () => {
    const dir = tempDir('dvalin-fix-store-');
    const good = record();
    saveFixRecord(good, dir);
    writeFileSync(path.join(dir, 'tampered.json'), JSON.stringify({ ...good, projectId: 'someone-else' }), 'utf8');
    writeFileSync(path.join(dir, 'garbage.json'), 'not json at all', 'utf8');

    const listed = listFixRecords(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.recordHash).toBe(good.recordHash);
  });

  it('reports no records rather than failing when nothing has been filed', () => {
    expect(listFixRecords(path.join(tempDir('dvalin-fix-store-'), 'absent'))).toEqual([]);
  });
});

describe('evidence pack carries fix records', () => {
  it('embeds them, hashes them into the manifest, and re-verifies each one', () => {
    const fixRecordsDir = tempDir('dvalin-fix-pack-');
    const auditDir = tempDir('dvalin-fix-pack-audit-');
    saveFixRecord(record(), fixRecordsDir);

    const pack = buildEvidencePack({ auditDir, fixRecordsDir });

    expect(pack.fixRecords).toHaveLength(1);
    expect(pack.manifest.sections.fixRecords).toBeTruthy();
    expect(verifyEvidencePack(pack).ok).toBe(true);
  });

  it('rejects a forged record embedded in a pack, on that record\'s own terms', () => {
    const fixRecordsDir = tempDir('dvalin-fix-pack-');
    const auditDir = tempDir('dvalin-fix-pack-audit-');
    saveFixRecord(record(), fixRecordsDir);
    const pack = buildEvidencePack({ auditDir, fixRecordsDir });

    // A record whose verdict was flipped to true and whose hash was recomputed
    // to match. The manifest would catch the substitution; this asserts the
    // per-record re-derivation catches it too, so a correctly resealed pack
    // still cannot launder one through.
    const failing = record({ passing: false });
    const forged = { ...failing, verdict: { verified: true, reasons: [] } };
    const resealed = { ...forged, recordHash: fixRecordHash(forged) };

    const report = verifyEvidencePack({ ...pack, fixRecords: [resealed] });

    expect(report.ok).toBe(false);
    expect(report.runIssues.join(' ')).toContain('does not follow from the record');
  });
});
