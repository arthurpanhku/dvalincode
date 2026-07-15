import { describe, expect, it } from 'vitest';
import {
  assertSafeTarEntries,
  assertTrustedGuiAssetUrl,
  fetchLatestGuiRelease,
  guiAssetName,
  macAppBundleFromExecutable,
  parseGuiReleaseTag,
} from '../src/core/guiUpdate.js';
import type { GithubRelease } from '../src/core/selfUpdate.js';

function release(tag: string, draft = false): GithubRelease {
  return {
    tag_name: tag,
    prerelease: false,
    draft,
    html_url: `https://github.com/arthurpanhku/dvalincode/releases/tag/${tag}`,
    assets: [
      { name: `asset-${tag}`, browser_download_url: `https://example.test/${tag}` },
    ],
  };
}

describe('Desktop GUI updates', () => {
  it('parses only gui-v release tags', () => {
    expect(parseGuiReleaseTag('gui-v0.13.0')).toEqual({ major: 0, minor: 13, patch: 0 });
    expect(parseGuiReleaseTag('v0.13.0')).toBeNull();
    expect(parseGuiReleaseTag('gui-latest')).toBeNull();
  });

  it('selects the highest non-draft GUI release', async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [release('v9.0.0'), release('gui-v0.13.0'), release('gui-v0.14.0', true), release('gui-v0.12.4')],
    });
    const latest = await fetchLatestGuiRelease({ fetchImpl });
    expect(latest.tag).toBe('gui-v0.13.0');
    expect(latest.version).toBe('0.13.0');
  });

  it('uses the GUI release asset naming matrix', () => {
    expect(guiAssetName('0.13.0', { os: 'macos', arch: 'arm64' }))
      .toBe('dvalincode-gui-v0.13.0-macos-arm64.tar.gz');
    expect(guiAssetName('v0.13.0', { os: 'windows', arch: 'x64' }))
      .toBe('dvalincode-gui-v0.13.0-windows-x64.zip');
  });

  it('accepts assets only from this repository release path', () => {
    const asset = 'https://github.com/arthurpanhku/dvalincode/releases/download/gui-v0.13.0/app.tar.gz';
    expect(assertTrustedGuiAssetUrl(asset, 'gui-v0.13.0')).toBe(asset);
    expect(() => assertTrustedGuiAssetUrl('https://example.test/app.tar.gz', 'gui-v0.13.0'))
      .toThrow('untrusted asset URL');
    expect(() => assertTrustedGuiAssetUrl('https://github.com/evil/repo/releases/download/gui-v0.13.0/app.tar.gz', 'gui-v0.13.0'))
      .toThrow('untrusted asset URL');
  });

  it('discovers the containing macOS app bundle', () => {
    expect(macAppBundleFromExecutable('/Applications/DvalinCode.app/Contents/MacOS/dvalincode-gui-macos-arm64'))
      .toBe('/Applications/DvalinCode.app');
    expect(macAppBundleFromExecutable('/tmp/dvalincode-gui-macos-arm64')).toBeNull();
  });

  it('rejects absolute and traversing tar entries', () => {
    expect(() => assertSafeTarEntries('dvalincode/DvalinCode.app/Contents/Info.plist\n')).not.toThrow();
    expect(() => assertSafeTarEntries('../../Applications/DvalinCode.app')).toThrow('path traversal');
    expect(() => assertSafeTarEntries('/Applications/DvalinCode.app')).toThrow('absolute path');
  });
});
