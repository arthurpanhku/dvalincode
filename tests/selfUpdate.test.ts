import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import {
  assetName,
  compareSemver,
  detectInstall,
  detectPlatform,
  fetchLatestRelease,
  isNewer,
  parseSemver,
  parseSums,
  sha256File,
  type GithubRelease,
} from '../src/core/selfUpdate.js';

const tmpDirs: string[] = [];
afterAll(() => {
  const { rmSync } = require('node:fs');
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('parseSemver', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseSemver('v0.12.1')).toEqual({ major: 0, minor: 12, patch: 1 });
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('v1.0.0-rc.1')).toEqual({ major: 1, minor: 0, patch: 0, pre: 'rc.1' });
  });

  it('rejects non-semver tags (e.g. the gui-* track)', () => {
    expect(parseSemver('gui-v0.12.0')).toBeNull();
    expect(parseSemver('nightly')).toBeNull();
    expect(parseSemver('')).toBeNull();
  });
});

describe('compareSemver / isNewer', () => {
  it('orders by major, minor, patch', () => {
    expect(compareSemver(parseSemver('1.0.0')!, parseSemver('0.9.9')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('0.12.1')!, parseSemver('0.12.0')!)).toBeGreaterThan(0);
    expect(compareSemver(parseSemver('0.12.0')!, parseSemver('0.12.0')!)).toBe(0);
  });

  it('treats a stable release as newer than its prerelease', () => {
    expect(compareSemver(parseSemver('1.0.0')!, parseSemver('1.0.0-rc.1')!)).toBeGreaterThan(0);
  });

  it('isNewer only fires on a strictly greater version', () => {
    expect(isNewer('0.12.1', '0.12.0')).toBe(true);
    expect(isNewer('0.12.0', '0.12.0')).toBe(false);
    expect(isNewer('0.11.0', '0.12.0')).toBe(false);
    expect(isNewer('garbage', '0.12.0')).toBe(false);
  });
});

describe('detectPlatform / assetName', () => {
  it('maps node platform/arch onto the published matrix', () => {
    expect(detectPlatform('darwin', 'arm64')).toEqual({ os: 'macos', arch: 'arm64' });
    expect(detectPlatform('linux', 'x64')).toEqual({ os: 'linux', arch: 'x64' });
    expect(detectPlatform('win32', 'x64')).toEqual({ os: 'windows', arch: 'x64' });
  });

  it('returns null for unpublished targets', () => {
    expect(detectPlatform('win32', 'arm64')).toBeNull();
    expect(detectPlatform('freebsd', 'x64')).toBeNull();
    expect(detectPlatform('linux', 'ppc64')).toBeNull();
  });

  it('builds the archive name matching build-release.sh', () => {
    expect(assetName('0.12.1', { os: 'macos', arch: 'arm64' })).toBe('dvalincode-v0.12.1-macos-arm64.tar.gz');
    expect(assetName('v0.12.1', { os: 'windows', arch: 'x64' })).toBe('dvalincode-v0.12.1-windows-x64.zip');
  });
});

describe('parseSums / sha256File', () => {
  it('parses shasum output keyed by basename', () => {
    const text = [
      'a'.repeat(64) + '  dvalincode-v0.12.1-macos-arm64.tar.gz',
      'b'.repeat(64) + '  dvalincode-v0.12.1-linux-x64.tar.gz',
    ].join('\n');
    const sums = parseSums(text);
    expect(sums.get('dvalincode-v0.12.1-macos-arm64.tar.gz')).toBe('a'.repeat(64));
    expect(sums.size).toBe(2);
  });

  it('computes a file checksum that matches its SHA256SUMS entry', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dvalincode-sum-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'artifact.bin');
    writeFileSync(file, 'hello dvalin');
    const hex = await sha256File(file);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    const sums = parseSums(`${hex}  artifact.bin`);
    expect(sums.get('artifact.bin')).toBe(hex);
  });
});

describe('detectInstall', () => {
  it('detects a compiled Bun binary as a binary install', () => {
    const info = detectInstall({ isBun: true, execPath: '/Users/me/.dvalincode/dvalincode' });
    expect(info.method).toBe('binary');
    expect(info.root).toBe('/Users/me/.dvalincode');
    expect(info.binary).toBe('/Users/me/.dvalincode/dvalincode');
  });

  it('detects a global npm install from the module path', () => {
    const info = detectInstall({
      isBun: false,
      execPath: '/usr/local/bin/node',
      moduleDir: '/usr/local/lib/node_modules/dvalincode/dist/commands',
    });
    expect(info.method).toBe('npm');
  });

  it('detects a source checkout', () => {
    const info = detectInstall({
      isBun: false,
      execPath: '/usr/local/bin/node',
      moduleDir: '/home/me/code/dvalincode/dist/commands',
    });
    expect(info.method).toBe('source');
  });
});

describe('fetchLatestRelease', () => {
  const release: GithubRelease = {
    tag_name: 'v0.12.1',
    prerelease: false,
    draft: false,
    html_url: 'https://github.com/arthurpanhku/dvalincode/releases/tag/v0.12.1',
    published_at: '2026-07-07T00:00:00Z',
    assets: [
      { name: 'dvalincode-v0.12.1-macos-arm64.tar.gz', browser_download_url: 'https://example/a' },
      { name: 'SHA256SUMS.txt', browser_download_url: 'https://example/s' },
    ],
  };

  const fakeFetch = (body: unknown) =>
    (async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => body })) as never;

  it('resolves the stable release via releases/latest', async () => {
    const info = await fetchLatestRelease({ fetchImpl: fakeFetch(release) });
    expect(info.version).toBe('0.12.1');
    expect(info.assets.get('SHA256SUMS.txt')).toBe('https://example/s');
  });

  it('picks the highest semver and ignores the gui-* track for prereleases', async () => {
    const list: GithubRelease[] = [
      { ...release, tag_name: 'gui-v0.13.0' },
      { ...release, tag_name: 'v0.12.1' },
      { ...release, tag_name: 'v0.13.0-rc.1', prerelease: true },
    ];
    const info = await fetchLatestRelease({ includePrerelease: true, fetchImpl: fakeFetch(list) });
    expect(info.version).toBe('0.13.0-rc.1');
  });

  it('throws on a non-ok response', async () => {
    const failing = (async () => ({ ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) })) as never;
    await expect(fetchLatestRelease({ fetchImpl: failing })).rejects.toThrow(/404/);
  });
});
