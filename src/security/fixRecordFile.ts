import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../core/exitCodes.js';
import {
  renderFixRecord,
  verifyFixRecord,
  type FixRecordVerification,
  type FixRecordVerifyOptions,
} from './fixRecord.js';
import type { FixRecordSignatureCheck } from './fixRecordSignature.js';

export type FixRecordFileVerification = FixRecordVerification & { path: string };

/** Load and re-derive a fix record without consulting a workspace or network. */
export async function verifyFixRecordFile(
  recordPath: string,
  cwd = process.cwd(),
  options: FixRecordVerifyOptions = {},
): Promise<FixRecordFileVerification> {
  const target = path.resolve(cwd, recordPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
  } catch (error) {
    throw new UsageError(`Cannot read fix record ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: target, ...verifyFixRecord(parsed, options) };
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
      renderSignatureSummary(check.signatures ?? []),
      meaning,
    ].join('\n');
  }
  return [
    'This fix record did not re-derive:',
    ...check.reasons.map(reason => `  · ${reason}`),
  ].join('\n');
}

/**
 * What the signatures do and do not establish, in one line.
 *
 * Re-derivation alone proves the record is self-consistent, which a forger can
 * also achieve. Saying so on every unsigned or untrusted record keeps a reader
 * from mistaking "re-derives" for "was issued by someone I trust".
 */
export function renderSignatureSummary(signatures: FixRecordSignatureCheck[]): string {
  const trusted = signatures.filter(signature => signature.trusted);
  if (trusted.length) {
    return `Signed by a trusted key: ${trusted.map(signature => signature.keyId).join(', ')}.`;
  }
  if (signatures.length) {
    return `Signed by ${signatures.map(signature => signature.keyId).join(', ')}, but no trusted key was named (--trusted-key), so who issued it is not established.`;
  }
  return 'Unsigned: re-derivation shows the record is self-consistent, not who issued it. Sign it (--sign-key) or re-execute it in CI (security reverify).';
}
