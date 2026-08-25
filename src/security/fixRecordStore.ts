import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyFixRecord, type VerifiedFixRecord } from './fixRecord.js';

/**
 * Where issued fix records accumulate.
 *
 * Kept beside the audit log rather than inside a workflow, because a record
 * outlives the workflow that produced it and is the thing a reviewer wants to
 * collect. Writes never throw into a verification: failing to file a record is
 * not a reason to fail the repair it describes.
 */
export function defaultFixRecordDir(): string {
  return process.env.DVALINCODE_FIX_RECORD_DIR
    ?? path.join(os.homedir(), '.dvalincode', 'security', 'fix-records');
}

/** Persist a record under its own hash, so filing the same one twice is a no-op. */
export function saveFixRecord(record: VerifiedFixRecord, dir: string = defaultFixRecordDir()): string | null {
  const target = path.join(dir, `${record.recordHash}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    if (existsSync(target)) return target;
    const temporary = `${target}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Every record on this install that still re-derives, newest first.
 *
 * A record that no longer verifies is skipped rather than surfaced: an Evidence
 * Pack that carried one would be asserting something it cannot support, and the
 * pack's own verification would reject it anyway.
 */
export function listFixRecords(dir: string = defaultFixRecordDir(), limit = 50): VerifiedFixRecord[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }

  const records: VerifiedFixRecord[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as unknown;
      const check = verifyFixRecord(parsed);
      if (check.ok && check.record) records.push(check.record);
    } catch {
      // An unreadable file is not evidence; leave it out rather than guess.
    }
  }
  return records
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .slice(0, limit);
}
