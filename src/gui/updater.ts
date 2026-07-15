import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  assertSafeTarEntries,
  assertTrustedGuiAssetUrl,
  fetchLatestGuiRelease,
  guiAssetName,
  macAppBundleFromExecutable,
} from '../core/guiUpdate.js';
import { detectPlatform, isNewer, parseSums, sha256File } from '../core/selfUpdate.js';
import { VERSION } from '../version.js';

const execFileAsync = promisify(execFile);
const UPDATE_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_DOWNLOAD_TIMEOUT_MS = 120_000;

export async function maybeInstallGuiUpdate(): Promise<boolean> {
  if (process.env.DVALINCODE_GUI_DISABLE_UPDATE === '1') return false;
  if (process.platform !== 'darwin') return false;

  const currentApp = macAppBundleFromExecutable(process.execPath);
  const platform = detectPlatform();
  if (!currentApp || !platform || platform.os !== 'macos') return false;

  let accepted = false;
  let workDir: string | undefined;
  let installerScheduled = false;
  try {
    const release = await fetchLatestGuiRelease({ signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
    if (!isNewer(release.version, VERSION)) return false;

    accepted = await confirmUpdate(VERSION, release.version);
    if (!accepted) return false;

    await access(path.dirname(currentApp), constants.W_OK);
    const asset = guiAssetName(release.version, platform);
    const archiveUrl = release.assets.get(asset);
    const sumsUrl = release.assets.get('SHA256SUMS-gui.txt');
    if (!archiveUrl || !sumsUrl) throw new Error(`Desktop GUI release ${release.tag} is incomplete.`);

    workDir = await mkdtemp(path.join(tmpdir(), 'dvalincode-gui-update-'));
    const archivePath = path.join(workDir, asset);
    const sumsPath = path.join(workDir, 'SHA256SUMS-gui.txt');
    await download(assertTrustedGuiAssetUrl(archiveUrl, release.tag), archivePath);
    await download(assertTrustedGuiAssetUrl(sumsUrl, release.tag), sumsPath);

    const expected = parseSums(await readFile(sumsPath, 'utf8')).get(asset);
    if (!expected) throw new Error(`${asset} is missing from SHA256SUMS-gui.txt.`);
    const actual = await sha256File(archivePath);
    if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}.`);

    const { stdout: listing } = await execFileAsync('/usr/bin/tar', ['-tzf', archivePath], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    assertSafeTarEntries(listing);

    const extractDir = path.join(workDir, 'extract');
    await execFileAsync('/bin/mkdir', ['-p', extractDir]);
    await execFileAsync('/usr/bin/tar', ['-xzf', archivePath, '-C', extractDir]);
    const stagedApp = await findAppBundle(extractDir);
    if (!stagedApp) throw new Error('Downloaded archive does not contain DvalinCode.app.');

    const { stdout: stagedVersion } = await execFileAsync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :CFBundleShortVersionString', path.join(stagedApp, 'Contents', 'Info.plist')],
      { encoding: 'utf8' },
    );
    if (stagedVersion.trim() !== release.version) {
      throw new Error(`Downloaded app reports ${stagedVersion.trim()}, expected ${release.version}.`);
    }

    await launchInstallerHelper({ currentApp, stagedApp, workDir });
    installerScheduled = true;
    return true;
  } catch (error) {
    console.error('dvalincode-gui: update failed:', error);
    if (accepted) await showUpdateError(error);
    return false;
  } finally {
    if (workDir && !installerScheduled) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'dvalincode-gui-update' },
    signal: AbortSignal.timeout(UPDATE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

async function confirmUpdate(current: string, latest: string): Promise<boolean> {
  const script = [
    'on run argv',
    'set currentVersion to item 1 of argv',
    'set latestVersion to item 2 of argv',
    'display dialog "DvalinCode " & latestVersion & " is available.\\n\\nCurrent version: " & currentVersion & "\\nThe update is checksum-verified and the app will restart." with title "DvalinCode Update" buttons {"Later", "Install and Restart"} default button "Install and Restart" cancel button "Later" with icon note',
    'return button returned of result',
    'end run',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script, current, latest], { encoding: 'utf8' });
    return stdout.trim() === 'Install and Restart';
  } catch {
    return false;
  }
}

async function showUpdateError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const script = [
    'on run argv',
    'display alert "DvalinCode update could not be installed" message (item 1 of argv) as warning',
    'end run',
  ].join('\n');
  await execFileAsync('/usr/bin/osascript', ['-e', script, message.slice(0, 500)]).catch(() => {});
}

async function findAppBundle(root: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    if (entry.name === 'DvalinCode.app') return candidate;
    const nested = await findAppBundle(candidate, depth + 1);
    if (nested) return nested;
  }
  return null;
}

async function launchInstallerHelper(options: {
  currentApp: string;
  stagedApp: string;
  workDir: string;
}): Promise<void> {
  const helperPath = path.join(options.workDir, 'install-update.sh');
  const helper = `#!/bin/sh
set -u
parent_pid="$1"
source_app="$2"
target_app="$3"
work_dir="$4"
backup_app="\${target_app}.dvalincode-backup"

while /bin/kill -0 "$parent_pid" 2>/dev/null; do /bin/sleep 0.2; done
/bin/rm -rf "$backup_app"
if [ -e "$target_app" ]; then /bin/mv "$target_app" "$backup_app" || exit 1; fi
if /usr/bin/ditto "$source_app" "$target_app"; then
  /usr/bin/xattr -dr com.apple.quarantine "$target_app" 2>/dev/null || true
  /bin/rm -rf "$backup_app"
  /usr/bin/open "$target_app"
  /bin/rm -rf "$work_dir"
else
  /bin/rm -rf "$target_app"
  if [ -e "$backup_app" ]; then /bin/mv "$backup_app" "$target_app"; fi
  /usr/bin/open "$target_app" 2>/dev/null || true
  exit 1
fi
`;
  await writeFile(helperPath, helper, { mode: 0o700 });
  await chmod(helperPath, 0o700);
  const child = spawn('/bin/sh', [
    helperPath,
    String(process.pid),
    options.stagedApp,
    options.currentApp,
    options.workDir,
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
