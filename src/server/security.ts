import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

let cachedRoots: string[] | undefined;
let cachedRootsKey: string | undefined;
const runtimeWorkspaceRoots = new Set<string>();
const MAX_USER_PATH_LENGTH = 4096;

function normalizeHost(value: string | undefined): string {
  return (value ?? '').replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function hostFromHeader(hostHeader: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (!raw) return undefined;
  try {
    return new URL(`http://${raw}`).hostname;
  } catch {
    return raw.split(':')[0];
  }
}

export function isLoopbackHost(hostname: string | undefined): boolean {
  const host = normalizeHost(hostname);
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function explicitAllowedOrigins(): Set<string> {
  return new Set(
    (process.env.DVALINCODE_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  );
}

export function isAllowedRequestOrigin(origin: string | undefined, hostHeader: string | string[] | undefined): boolean {
  if (!origin) return true;

  const explicit = explicitAllowedOrigins();
  if (explicit.has(origin)) return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const requestHost = hostFromHeader(hostHeader);
  const sameHost = normalizeHost(parsed.hostname) === normalizeHost(requestHost);

  return isLoopbackHost(requestHost) && (sameHost || isLoopbackHost(parsed.hostname));
}

function configuredWorkspaceRoots(): string[] {
  const raw = process.env.DVALINCODE_WORKSPACE_ROOTS;
  if (!raw) return [process.cwd(), path.join(homedir(), '.dvalincode', 'projects')];
  return raw
    .split(path.delimiter)
    .map(root => root.trim())
    .filter(Boolean);
}

export function assertSafeUserPathInput(input: string, label = 'path'): string {
  const value = input.trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.length > MAX_USER_PATH_LENGTH) throw new Error(`${label} is too long`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} contains invalid characters`);

  const looksLikeUrl = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  if (looksLikeUrl && !isWindowsDrive) throw new Error(`${label} must be a filesystem path`);

  return value;
}

async function allowedWorkspaceRoots(): Promise<string[]> {
  const cacheKey = `${process.env.DVALINCODE_WORKSPACE_ROOTS ?? ''}\0${[...runtimeWorkspaceRoots].join('\0')}`;
  if (cachedRoots && cachedRootsKey === cacheKey) return cachedRoots;
  const roots = [...configuredWorkspaceRoots(), ...runtimeWorkspaceRoots];
  const resolved: string[] = [];
  for (const root of roots) {
    const absolute = path.resolve(root);
    await mkdir(absolute, { recursive: true }).catch(() => {});
    resolved.push(absolute);
    const canonical = await realpath(absolute);
    if (!resolved.includes(canonical)) resolved.push(canonical);
  }
  cachedRoots = resolved;
  cachedRootsKey = cacheKey;
  return cachedRoots;
}

export function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function containmentCandidates(candidate: string): string[] {
  if (process.platform === 'darwin' && candidate.startsWith('/var/')) {
    return [candidate, `/private${candidate}`];
  }
  return [candidate];
}

export async function resolveAllowedCwd(input?: string): Promise<string> {
  const raw = assertSafeUserPathInput(input ?? process.cwd(), 'cwd');
  const roots = await allowedWorkspaceRoots();
  const candidate = path.resolve(raw);
  const candidates = containmentCandidates(candidate);
  const contained = candidates.find(candidateForm =>
    roots.some(root => pathIsInside(root, candidateForm)),
  );
  if (!contained) {
    throw new Error(`Workspace is not allowed: ${candidate}`);
  }
  return contained;
}

export async function resolveAllowedNewPath(input: string, label = 'path'): Promise<string> {
  const raw = assertSafeUserPathInput(input, label);
  const roots = await allowedWorkspaceRoots();
  const candidate = path.resolve(raw);
  const candidates = containmentCandidates(candidate);
  if (!roots.some(root => candidates.some(candidateForm => pathIsInside(root, candidateForm)))) {
    throw new Error(`Workspace is not allowed: ${candidate}`);
  }
  return candidate;
}

export async function allowWorkspaceRoot(input: string): Promise<string> {
  const candidate = path.resolve(assertSafeUserPathInput(input, 'workspace root'));
  runtimeWorkspaceRoots.add(candidate);
  cachedRoots = undefined;
  cachedRootsKey = undefined;
  return candidate;
}
