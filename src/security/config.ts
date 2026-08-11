import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { UsageError } from '../core/exitCodes.js';
import type { DvalinScannerId } from '../remediation/scannerSuite.js';
import type { SecurityGateMode, SecurityThreshold } from './contracts.js';

export const SECURITY_CONFIG_FILE = 'dvalin.security.json';
export const DEFAULT_BASELINE_FILE = '.dvalin/baseline.json';

export type SecuritySuppression = {
  fingerprint?: string;
  ruleId?: string;
  path?: string;
  reason: string;
  owner?: string;
  expiresAt?: string;
};

export type DvalinSecurityConfig = {
  version: 1;
  scanners: DvalinScannerId[];
  gate: {
    severity: SecurityThreshold;
    mode: SecurityGateMode;
  };
  baseline: string;
  checks: Array<'test' | 'typecheck' | 'build' | 'lint'>;
  suppressions: SecuritySuppression[];
};

export const DEFAULT_SECURITY_CONFIG: DvalinSecurityConfig = {
  version: 1,
  scanners: ['builtin'],
  gate: { severity: 'none', mode: 'all' },
  baseline: DEFAULT_BASELINE_FILE,
  checks: ['test'],
  suppressions: [],
};

export const INITIALIZED_SECURITY_CONFIG: DvalinSecurityConfig = {
  ...DEFAULT_SECURITY_CONFIG,
  gate: { severity: 'high', mode: 'new' },
};

export async function loadSecurityConfig(root: string, explicitPath?: string): Promise<{
  config: DvalinSecurityConfig;
  path?: string;
}> {
  const candidate = explicitPath ? path.resolve(root, explicitPath) : path.join(root, SECURITY_CONFIG_FILE);
  try {
    await access(candidate, constants.R_OK);
  } catch {
    if (explicitPath) throw new UsageError(`Security config not found: ${candidate}`);
    return { config: structuredClone(DEFAULT_SECURITY_CONFIG) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(candidate, 'utf8')) as unknown;
  } catch (error) {
    throw new UsageError(`Invalid security config ${candidate}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { config: parseSecurityConfig(parsed, candidate), path: candidate };
}

export async function writeInitialSecurityConfig(root: string, force = false): Promise<string> {
  const target = path.join(root, SECURITY_CONFIG_FILE);
  if (!force) {
    try {
      await access(target, constants.F_OK);
      throw new UsageError(`${SECURITY_CONFIG_FILE} already exists. Use --force to replace it.`);
    } catch (error) {
      if (error instanceof UsageError) throw error;
    }
  }
  await writeFile(target, `${JSON.stringify(INITIALIZED_SECURITY_CONFIG, null, 2)}\n`, 'utf8');
  return target;
}

export function parseSecurityConfig(value: unknown, source = SECURITY_CONFIG_FILE): DvalinSecurityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${source} must contain a JSON object.`);
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new UsageError(`${source}: version must be 1.`);
  const scanners = parseScanners(input.scanners, source);
  const gateInput = asRecord(input.gate);
  const severity = gateInput?.severity ?? DEFAULT_SECURITY_CONFIG.gate.severity;
  const mode = gateInput?.mode ?? DEFAULT_SECURITY_CONFIG.gate.mode;
  if (!['critical', 'high', 'medium', 'low', 'none'].includes(String(severity))) {
    throw new UsageError(`${source}: gate.severity must be critical, high, medium, low, or none.`);
  }
  if (mode !== 'all' && mode !== 'new') throw new UsageError(`${source}: gate.mode must be all or new.`);
  const baseline = input.baseline ?? DEFAULT_SECURITY_CONFIG.baseline;
  if (typeof baseline !== 'string' || !baseline.trim()) throw new UsageError(`${source}: baseline must be a path string.`);
  const checks = input.checks ?? DEFAULT_SECURITY_CONFIG.checks;
  if (!Array.isArray(checks) || checks.some(check => !['test', 'typecheck', 'build', 'lint'].includes(String(check)))) {
    throw new UsageError(`${source}: checks must contain only test, typecheck, build, or lint.`);
  }
  const suppressions = input.suppressions ?? [];
  if (!Array.isArray(suppressions)) throw new UsageError(`${source}: suppressions must be an array.`);
  return {
    version: 1,
    scanners,
    gate: { severity: severity as SecurityThreshold, mode },
    baseline,
    checks: [...new Set(checks)] as DvalinSecurityConfig['checks'],
    suppressions: suppressions.map((suppression, index) => parseSuppression(suppression, `${source}: suppressions[${index}]`)),
  };
}

export function resolveSecurityPath(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new UsageError(`Security artifact path must stay inside the workspace: ${candidate}`);
  }
  return resolved;
}

function parseScanners(value: unknown, source: string): DvalinScannerId[] {
  const scanners = value ?? DEFAULT_SECURITY_CONFIG.scanners;
  const allowed: DvalinScannerId[] = ['builtin', 'semgrep', 'trivy', 'osv-scanner'];
  if (!Array.isArray(scanners) || !scanners.length || scanners.some(scanner => !allowed.includes(scanner as DvalinScannerId))) {
    throw new UsageError(`${source}: scanners must contain one or more of ${allowed.join(', ')}.`);
  }
  return [...new Set(scanners)] as DvalinScannerId[];
}

function parseSuppression(value: unknown, source: string): SecuritySuppression {
  const input = asRecord(value);
  if (!input) throw new UsageError(`${source} must be an object.`);
  if (typeof input.reason !== 'string' || !input.reason.trim()) throw new UsageError(`${source}.reason is required.`);
  if (!input.fingerprint && !input.ruleId) throw new UsageError(`${source} needs fingerprint or ruleId.`);
  for (const field of ['fingerprint', 'ruleId', 'path', 'owner', 'expiresAt'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'string') throw new UsageError(`${source}.${field} must be a string.`);
  }
  if (typeof input.expiresAt === 'string' && !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new UsageError(`${source}.expiresAt must be an ISO date.`);
  }
  return {
    fingerprint: input.fingerprint as string | undefined,
    ruleId: input.ruleId as string | undefined,
    path: input.path as string | undefined,
    reason: input.reason,
    owner: input.owner as string | undefined,
    expiresAt: input.expiresAt as string | undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
