import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../core/exitCodes.js';
import {
  renderFixRecord,
  verifyFixRecord,
  type FixRecordVerification,
} from './fixRecord.js';

export type FixRecordFileVerification = FixRecordVerification & { path: string };

/** Load and re-derive a fix record without consulting a workspace or network. */
export async function verifyFixRecordFile(
  recordPath: string,
  cwd = process.cwd(),
): Promise<FixRecordFileVerification> {
  const target = path.resolve(cwd, recordPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
  } catch (error) {
    throw new UsageError(`Cannot read fix record ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: target, ...verifyFixRecord(parsed) };
}

/** Human-readable verification output shared by the CLI and interactive TUI. */
export function renderFixRecordVerification(check: FixRecordVerification): string {
  if (!check.record) throw new UsageError('Not a Dvalin fix record.');
  if (check.ok) {
    const meaning = check.record.verdict.verified
      ? 'It attests that these findings were gone and these checks were observed to pass. It is not a claim that the code is free of vulnerabilities.'
      : 'Its NOT VERIFIED verdict and caveats are intact; this record does not attest that the repair passed verification.';
    return [
      renderFixRecord(check.record),
      '',
      'Re-derived successfully: this record is unmodified and its verdict follows from its own evidence.',
      meaning,
    ].join('\n');
  }
  return [
    'This fix record did not re-derive:',
    ...check.reasons.map(reason => `  · ${reason}`),
  ].join('\n');
}
