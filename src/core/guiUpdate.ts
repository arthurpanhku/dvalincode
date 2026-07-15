import path from 'node:path';
import {
  RELEASE_REPO,
  compareSemver,
  parseSemver,
  type GithubRelease,
  type Platform,
  type Semver,
} from './selfUpdate.js';

export type GuiReleaseInfo = {
  tag: string;
  version: string;
  htmlUrl: string;
  assets: Map<string, string>;
};

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

export function parseGuiReleaseTag(tag: string): Semver | null {
  const match = /^gui-(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  return match ? parseSemver(match[1]) : null;
}

export function guiAssetName(version: string, platform: Platform): string {
  const normalized = version.replace(/^v/, '');
  const extension = platform.os === 'windows' ? 'zip' : 'tar.gz';
  return `dvalincode-gui-v${normalized}-${platform.os}-${platform.arch}.${extension}`;
}

export function assertTrustedGuiAssetUrl(value: string, releaseTag: string): string {
  const url = new URL(value);
  const expectedPrefix = `/${RELEASE_REPO}/releases/download/${releaseTag}/`;
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedPrefix)) {
    throw new Error(`Desktop GUI release contains an untrusted asset URL: ${url.origin}`);
  }
  return url.toString();
}

export async function fetchLatestGuiRelease(options: {
  repo?: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
} = {}): Promise<GuiReleaseInfo> {
  const repo = options.repo ?? RELEASE_REPO;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const url = `https://api.github.com/repos/${repo}/releases?per_page=30`;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dvalincode-gui-update' },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);

  const releases = (await response.json()) as GithubRelease[];
  const release = releases
    .filter(candidate => !candidate.draft && parseGuiReleaseTag(candidate.tag_name) !== null)
    .sort((a, b) => compareSemver(parseGuiReleaseTag(b.tag_name)!, parseGuiReleaseTag(a.tag_name)!))[0];
  if (!release) throw new Error('No Desktop GUI release was found.');

  return {
    tag: release.tag_name,
    version: release.tag_name.replace(/^gui-v/, ''),
    htmlUrl: release.html_url,
    assets: new Map(release.assets.map(asset => [asset.name, asset.browser_download_url])),
  };
}

export function macAppBundleFromExecutable(executable: string): string | null {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = executable.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const candidate = executable.slice(0, markerIndex);
  return candidate.endsWith('.app') ? candidate : null;
}

export function assertSafeTarEntries(listing: string): void {
  for (const rawEntry of listing.split('\n')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    if (entry.includes('\0') || path.posix.isAbsolute(entry)) {
      throw new Error(`GUI archive contains an unsafe absolute path: ${entry}`);
    }
    const segments = entry.replace(/^\.\//, '').split('/');
    if (segments.includes('..')) {
      throw new Error(`GUI archive contains path traversal: ${entry}`);
    }
  }
}
