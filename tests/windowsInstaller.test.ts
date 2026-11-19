import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The Windows desktop app is the one artifact nothing in this repository can
 * run: Inno Setup is a Windows program, Bun stamps an .exe icon only on a
 * Windows host, and no test here opens a WebView2 window. So what is checked
 * is the seam between the four files that have to agree — the icon, the Inno
 * script, the build script and the release workflow — because every way this
 * has broken so far was one of them silently disagreeing with another (the
 * cross-built .exe carried no icon for four releases, and `--windows-icon`
 * still pointed at an SVG that Bun cannot read).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const iss = read(path.join('installer', 'windows', 'dvalincode.iss'));
const buildScript = read(path.join('scripts', 'build-gui.sh'));
const workflow = read(path.join('.github', 'workflows', 'release-gui.yml'));

describe('Windows application icon', () => {
  const icon = readFileSync(path.join(repoRoot, 'installer', 'windows', 'dvalincode.ico'));

  /** ICONDIR: reserved=0, type=1 (icon), count. */
  function entries() {
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    const count = icon.readUInt16LE(4);
    return Array.from({ length: count }, (_, index) => {
      const at = 6 + index * 16;
      return {
        // 0 in the directory means 256: the byte is one wide.
        width: icon.readUInt8(at) === 0 ? 256 : icon.readUInt8(at),
        bytes: icon.readUInt32LE(at + 8),
        offset: icon.readUInt32LE(at + 12),
      };
    });
  }

  it('is a multi-size icon Windows can draw everywhere it shows one', () => {
    const sizes = entries().map(entry => entry.width);
    // 16/32 for Explorer lists and the window, 48 for the desktop shortcut,
    // 256 for the extra-large view and the installer's own icon.
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
  });

  it('points every directory entry at image data inside the file', () => {
    for (const entry of entries()) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.offset + entry.bytes).toBeLessThanOrEqual(icon.length);
    }
  });

  it('is regenerated from the app icon SVG, not hand-edited', () => {
    const generator = read(path.join('scripts', 'generate-windows-icon.mjs'));
    expect(generator).toContain('app-icon-');
    expect(generator).toContain(path.join('installer', 'windows', 'dvalincode.ico').replace(/\\/g, '\\\\'));
  });
});

describe('Inno Setup script', () => {
  it('installs per-user, so the install raises no UAC prompt', () => {
    // An administrator install would also put the app outside the profile of
    // the user who asked for it, and the in-app updater could not replace it.
    expect(iss).toMatch(/^PrivilegesRequired=lowest$/m);
    expect(iss).toMatch(/^DefaultDirName=\{autopf\}\\\{#AppName\}$/m);
  });

  it('keeps one AppId, which is what an upgrade and the uninstaller match on', () => {
    const appIds = [...iss.matchAll(/^AppId=(.+)$/gm)].map(match => match[1].trim());
    expect(appIds).toHaveLength(1);
    expect(appIds[0]).toMatch(/^\{\{[0-9A-F-]{36}\}$/);
  });

  it('ships web/dist beside the executable', () => {
    // A compiled Bun binary resolves its static assets next to itself; without
    // this the window opens on an ENOENT under the virtual bundle path.
    expect(iss).toMatch(/Source: "\{#SourceDir\}\\web\\dist\\\*"; DestDir: "\{app\}\\web\\dist"/);
    expect(iss).toContain('recursesubdirs');
  });

  it('gives Windows a Start menu entry, an uninstall entry and an icon', () => {
    expect(iss).toMatch(/^\[Icons\]$/m);
    expect(iss).toContain('{group}\\{#AppName}');
    expect(iss).toContain('{cm:UninstallProgram,{#AppName}}');
    expect(iss).toMatch(/^UninstallDisplayIcon=\{app\}\\\{#InstalledExe\}$/m);
  });

  it('installs the WebView2 runtime when it is missing', () => {
    // Without it the native window opens blank — the one failure a user has
    // no way to diagnose.
    expect(iss).toContain('{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
    expect(iss).toContain('MicrosoftEdgeWebview2Setup.exe');
    expect(iss).toContain('/silent /install');
    expect(iss).toContain('Check: NeedsWebView2');
  });

  it('names only a translation Inno Setup itself ships', () => {
    // A MessagesFile the compiler cannot find fails the build, and most
    // translations (Chinese among them) are third-party .isl files.
    const messageFiles = [...iss.matchAll(/MessagesFile: "([^"]+)"/g)].map(match => match[1]);
    expect(messageFiles).toEqual(['compiler:Default.isl']);
  });

  it('requires the build script to pass the version and the payload in', () => {
    expect(iss).toMatch(/#error "AppVersion must be passed/);
    expect(iss).toMatch(/#error "SourceDir must be passed/);
  });
});

describe('build-gui.sh', () => {
  it('hands Bun the .ico, which is the only icon format it accepts', () => {
    expect(buildScript).toContain('installer/windows/dvalincode.ico');
    const iconFlag = buildScript.match(/--windows-icon="([^"]+)"/)?.[1];
    expect(iconFlag).toBe('$WINDOWS_ICON');
  });

  it('fails loudly when the icon is missing instead of shipping an .exe without one', () => {
    expect(buildScript).toMatch(/\[ -f "\$WINDOWS_ICON" \][^\n]*exit 1/);
  });

  it('builds the installer from the packaged payload', () => {
    expect(buildScript).toContain('build_windows_installer');
    expect(buildScript).toContain('/DSourceDir=');
    expect(buildScript).toContain('/DAppVersion=');
  });

  it('names the installer so the checksum glob and the release both pick it up', () => {
    // SHA256SUMS-gui.txt is generated with `shasum -a 256 dvalincode-gui-v*`,
    // and the release publishes the same glob.
    const outBase = buildScript.match(/out_base="([^"]+)"/)?.[1];
    expect(outBase).toBe('dvalincode-gui-v${VERSION}-windows-x64-setup');
  });

  it('takes several targets, so one runner can build macOS and Linux', () => {
    expect(buildScript).toContain('FILTERS=("$@")');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['build:gui:unix']).toBe('bash scripts/build-gui.sh darwin linux');
    expect(pkg.scripts['build:gui:windows']).toBe('bash scripts/build-gui.sh windows');
  });

  it('packages the archive without assuming `zip` exists on a Windows runner', () => {
    expect(buildScript).toContain('make_zip');
    expect(buildScript).toMatch(/command -v 7z/);
  });
});

describe('release-gui workflow', () => {
  it('builds the Windows artifacts on Windows', () => {
    // Cross-building them from macOS is what left the .exe with no icon and
    // no installer at all.
    expect(workflow).toMatch(/build-gui-windows:\n\s+name: .*\n\s+runs-on: windows-latest/);
    expect(workflow).toContain('npm run build:gui:windows');
    expect(workflow).toContain('npm run build:gui:unix');
    expect(workflow).not.toMatch(/run: npm run build:gui$/m);
  });

  it('merges the two jobs’ checksum files into the one the updater fetches', () => {
    // src/gui/updater.ts downloads SHA256SUMS-gui.txt by that exact name.
    expect(workflow).toContain('SHA256SUMS-gui-windows.txt');
    expect(workflow).toContain('sha256sum -c SHA256SUMS-gui.txt');
    expect(read(path.join('src', 'gui', 'updater.ts'))).toContain("'SHA256SUMS-gui.txt'");
  });

  it('waits for both builds before attesting and publishing', () => {
    const needs = [...workflow.matchAll(/^\s+needs: (.+)$/gm)].map(match => match[1]);
    expect(needs).toContain('[build-gui, build-gui-windows]');
    expect(needs).toContain('[build-gui, build-gui-windows, attest-gui]');
  });
});
