import { randomUUID, timingSafeEqual } from 'node:crypto';

type ScannerWorkspaceGrant = {
  cwd: string;
  expiresAt: number;
};

const scannerWorkspaceGrants = new Map<string, ScannerWorkspaceGrant>();
const GRANT_TTL_MS = 5 * 60_000;
const MAX_GRANTS = 100;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pruneScannerWorkspaceGrants(now: number): void {
  for (const [token, grant] of scannerWorkspaceGrants) {
    if (grant.expiresAt <= now) scannerWorkspaceGrants.delete(token);
  }
  while (scannerWorkspaceGrants.size >= MAX_GRANTS) {
    const oldest = scannerWorkspaceGrants.keys().next().value as string | undefined;
    if (!oldest) break;
    scannerWorkspaceGrants.delete(oldest);
  }
}

/**
 * Issue a short-lived, one-use capability for an already-authorized workspace.
 * Keeping the canonical path server-side prevents HTTP request data from being
 * forwarded into the scanner's filesystem and subprocess boundaries.
 */
export function issueScannerWorkspaceGrant(authorizedCwd: string): string {
  const now = Date.now();
  pruneScannerWorkspaceGrants(now);
  const token = randomUUID();
  scannerWorkspaceGrants.set(token, { cwd: authorizedCwd, expiresAt: now + GRANT_TTL_MS });
  return token;
}

export function consumeScannerWorkspaceGrant(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new Error('Scanner workspace grant is invalid');
  }

  const requestedToken = Buffer.from(value, 'ascii');
  let grant: ScannerWorkspaceGrant | undefined;
  for (const [token, candidate] of scannerWorkspaceGrants) {
    if (!timingSafeEqual(Buffer.from(token, 'ascii'), requestedToken)) continue;
    grant = candidate;
    scannerWorkspaceGrants.delete(token);
    break;
  }
  if (!grant || grant.expiresAt <= Date.now()) {
    throw new Error('Scanner workspace grant is invalid or expired');
  }
  return grant.cwd;
}
