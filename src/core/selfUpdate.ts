/**
 * Self-update core — the testable logic behind `dvalincode update`.
 *
 * The CLI ships as a self-contained Bun binary published to GitHub Releases
 * (see scripts/build-release.sh): each release carries
 * `dvalincode-vX.Y.Z-<os>-<arch>.{tar.gz,zip}` assets plus a `SHA256SUMS.txt`.
 * This module knows how to find the latest release, name the asset for the
 * current platform, and verify a download against the published checksum.
 *
 * Everything here is pure or dependency-injected (the GitHub fetch is passed
 * in) so it can be unit-tested without network access. The orchestration —
 * downloading, extracting, and swapping files — lives in commands/update.ts.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';

/** The single repo the CLI updates from. */
export const RELEASE_REPO = 'arthurpanhku/dvalincode';

/** Host contacted for release metadata + downloads — surfaced to the user for transparency. */
export const RELEASE_HOSTS = ['api.github.com', 'github.com'] as const;

// ── Version comparison ────────────────────────────────────────────────────────

export type Semver = { major: number; minor: number; patch: number; pre?: string };

/** Parse `v1.2.3` / `1.2.3` / `1.2.3-rc.1`. Returns null for anything else (e.g. `gui-v1.2.3`). */
export function parseSemver(tag: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag.trim());
  if (!m) return null;
  const pre = m[4];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(pre ? { pre } : {}) };
}

/** >0 if a>b, <0 if a<b, 0 if equal. A stable release outranks a prerelease of the same core. */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && b.pre) return a.pre === b.pre ? 0 : a.pre < b.pre ? -1 : 1;
  return 0;
}

/** True when `latest` is a strictly newer version than `current`. Unparseable inputs → false. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  return compareSemver(l, c) > 0;
}

// ── Platform → asset name ─────────────────────────────────────────────────────

export type Platform = { os: 'macos' | 'linux' | 'windows'; arch: 'arm64' | 'x64' };

/** Map Node's platform/arch onto the published release matrix. null = no published build. */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Platform | null {
  let os: Platform['os'];
  switch (platform) {
    case 'darwin':
      os = 'macos';
      break;
    case 'linux':
      os = 'linux';
      break;
    case 'win32':
      os = 'windows';
      break;
    default:
      return null;
  }
  let a: Platform['arch'];
  switch (arch) {
    case 'arm64':
      a = 'arm64';
      break;
    case 'x64':
      a = 'x64';
      break;
    default:
      return null;
  }
  // Only Windows x64 is published (mirrors scripts/install.sh).
  if (os === 'windows' && a === 'arm64') return null;
  return { os, arch: a };
}

/** Archive filename for a version+platform, e.g. `dvalincode-v0.12.1-macos-arm64.tar.gz`. */
export function assetName(version: string, p: Platform): string {
  const v = version.startsWith('v') ? version : `v${version}`;
  const ext = p.os === 'windows' ? 'zip' : 'tar.gz';
  return `dvalincode-${v}-${p.os}-${p.arch}.${ext}`;
}

// ── Checksums ─────────────────────────────────────────────────────────────────

/** Parse `shasum -a 256` output ("<hex>␠␠<filename>") into filename → lowercase hex. */
export function parseSums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) map.set(path.basename(m[2]), m[1].toLowerCase());
  }
  return map;
}

/** Stream a file through SHA-256; returns lowercase hex. */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ── Install-method detection ──────────────────────────────────────────────────

export type InstallMethod = 'binary' | 'npm' | 'source' | 'unknown';
export type InstallInfo = {
  method: InstallMethod;
  /** For `binary`: the directory holding the runnable binary (the swap target). */
  root?: string;
  /** For `binary`: absolute path to the currently running binary. */
  binary?: string;
};

/**
 * Work out how this process was launched so `update` can pick the right mechanism.
 *
 * - `binary`  — a Bun `--compile` single-file executable named `dvalincode*`
 *               (what the installer drops in ~/.dvalincode). `execPath` *is* our binary.
 * - `npm`     — running under node from a global npm install (module under node_modules/).
 * - `source`  — running from a git checkout (module under a repo we can `git pull`).
 *
 * Injectable args keep it unit-testable.
 */
export function detectInstall(opts?: {
  execPath?: string;
  moduleDir?: string;
  isBun?: boolean;
}): InstallInfo {
  const execPath = opts?.execPath ?? process.execPath;
  const isBun = opts?.isBun ?? Boolean(process.versions.bun);
  const execBase = path.basename(execPath).toLowerCase();

  // A compiled Bun app reports its own path as execPath (not `bun`/`node`).
  if (isBun && execBase.startsWith('dvalincode')) {
    return { method: 'binary', root: path.dirname(execPath), binary: execPath };
  }

  const moduleDir = opts?.moduleDir;
  if (moduleDir) {
    const normalized = moduleDir.split(path.sep).join('/');
    if (normalized.includes('/node_modules/')) return { method: 'npm' };
    return { method: 'source', root: moduleDir };
  }

  return { method: 'unknown' };
}

// ── Release lookup ────────────────────────────────────────────────────────────

/** Minimal shape of a GitHub release we care about. */
export type GithubRelease = {
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  published_at?: string;
  assets: Array<{ name: string; browser_download_url: string }>;
};

export type ReleaseInfo = {
  tag: string;
  version: string;
  prerelease: boolean;
  htmlUrl: string;
  publishedAt?: string;
  assets: Map<string, string>;
};

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

function toReleaseInfo(r: GithubRelease): ReleaseInfo {
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^v/, ''),
    prerelease: r.prerelease,
    htmlUrl: r.html_url,
    ...(r.published_at ? { publishedAt: r.published_at } : {}),
    assets: new Map(r.assets.map(a => [a.name, a.browser_download_url])),
  };
}

/**
 * Resolve the release to update to.
 *
 * - Stable (default): GitHub's `releases/latest`, which already excludes drafts,
 *   prereleases, and the separate `gui-*` desktop track.
 * - `includePrerelease`: scan recent releases and pick the highest semver tag,
 *   ignoring anything whose tag isn't plain semver (e.g. `gui-v*`).
 */
export async function fetchLatestRelease(opts: {
  repo?: string;
  includePrerelease?: boolean;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ReleaseInfo> {
  const repo = opts.repo ?? RELEASE_REPO;
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'dvalincode-update' };

  if (!opts.includePrerelease) {
    const url = `https://api.github.com/repos/${repo}/releases/latest`;
    const res = await doFetch(url, { headers, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
    return toReleaseInfo((await res.json()) as GithubRelease);
  }

  const url = `https://api.github.com/repos/${repo}/releases?per_page=30`;
  const res = await doFetch(url, { headers, ...(opts.signal ? { signal: opts.signal } : {}) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText} for ${url}`);
  const releases = (await res.json()) as GithubRelease[];
  const candidates = releases
    .filter(r => !r.draft && parseSemver(r.tag_name) !== null)
    .sort((a, b) => compareSemver(parseSemver(b.tag_name)!, parseSemver(a.tag_name)!));
  if (candidates.length === 0) throw new Error('No versioned releases found.');
  return toReleaseInfo(candidates[0]);
}
