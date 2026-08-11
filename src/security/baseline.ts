import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from '../core/exitCodes.js';
import type { DvalinScanSuiteResult } from '../remediation/scannerSuite.js';
import { createBaseline, isSecurityBaseline, type SecurityBaseline } from './contracts.js';
import { resolveSecurityPath } from './config.js';

export async function readSecurityBaseline(root: string, file: string): Promise<SecurityBaseline> {
  const target = resolveSecurityPath(root, file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8')) as unknown;
  } catch (error) {
    throw new UsageError(`Cannot read security baseline ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isSecurityBaseline(parsed)) throw new UsageError(`Invalid or unsupported security baseline: ${target}`);
  return parsed;
}

export async function writeSecurityBaseline(root: string, file: string, result: DvalinScanSuiteResult): Promise<{
  path: string;
  baseline: SecurityBaseline;
}> {
  const target = resolveSecurityPath(root, file);
  const baseline = createBaseline(result);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return { path: target, baseline };
}
