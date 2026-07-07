import type { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename, chmod, readdir, stat, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { VERSION } from '../version.js';
import {
  RELEASE_REPO,
  RELEASE_HOSTS,
  assetName,
  detectInstall,
  detectPlatform,
  fetchLatestRelease,
  isNewer,
  parseSums,
  sha256File,
  type InstallInfo,
  type ReleaseInfo,
} from '../core/selfUpdate.js';

const execFileAsync = promisify(execFile);

type UpdateOptions = {
  check?: boolean;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
  prerelease?: boolean;
};

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .alias('upgrade')
    .description('Update DvalinCode to the latest release on GitHub')
    .option('--check', 'only check whether a newer version exists; do not modify anything')
    .option('-y, --yes', 'apply the update without an interactive confirmation')
    .option('--force', 'reinstall even if already on the latest version')
    .option('--prerelease', 'include prereleases when resolving the latest version')
    .option('--json', 'print the update status as JSON (implies --check)')
    .action(async (options: UpdateOptions) => {
      try {
        await runUpdate(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (options.json) {
          console.log(JSON.stringify({ ok: false, error: message }, null, 2));
        } else {
          console.error(`update: ${message}`);
        }
        process.exitCode = 1;
      }
    });
}

async function runUpdate(options: UpdateOptions): Promise<void> {
  const current = VERSION;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const install = detectInstall({ moduleDir });

  if (!options.json) {
    console.log(`Contacting ${RELEASE_HOSTS.join(', ')} for the latest release…`);
  }

  const release = await fetchLatestRelease({
    includePrerelease: options.prerelease,
    signal: AbortSignal.timeout(20_000),
  });

  const updateAvailable = isNewer(release.version, current);

  // ── check / json: report and stop ─────────────────────────────────────────
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          current,
          latest: release.version,
          updateAvailable,
          prerelease: release.prerelease,
          installMethod: install.method,
          releaseUrl: release.htmlUrl,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`  current  ${current}`);
  console.log(`  latest   ${release.version}${release.prerelease ? ' (prerelease)' : ''}`);
  console.log('');

  if (!updateAvailable && !options.force) {
    console.log(`✓ You're on the latest version (${current}).`);
    return;
  }

  if (options.check) {
    console.log(
      updateAvailable
        ? `↑ Update available: ${current} → ${release.version}\n  Run \`dvalincode update\` to install it.`
        : `Re-run without --check to reinstall ${release.version}.`,
    );
    return;
  }

  // ── Confirm ────────────────────────────────────────────────────────────────
  const verb = updateAvailable ? `Update ${current} → ${release.version}` : `Reinstall ${release.version}`;
  if (!options.yes) {
    const ok = await confirm(`${verb} via the ${install.method} install?`);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  // ── Apply per install method ───────────────────────────────────────────────
  switch (install.method) {
    case 'binary':
      await applyBinaryUpdate(install, release);
      break;
    case 'npm':
      await applyNpmUpdate(release);
      break;
    case 'source':
      printSourceGuidance(install, release);
      break;
    default:
      printManualGuidance(release);
  }
}

// ── binary: download, verify checksum, swap in place ─────────────────────────

async function applyBinaryUpdate(install: InstallInfo, release: ReleaseInfo): Promise<void> {
  const root = install.root!;
  const targetBinary = install.binary!;

  const platform = detectPlatform();
  if (!platform) {
    throw new Error(`No published binary for ${process.platform}/${process.arch}.`);
  }
  if (platform.os === 'windows') {
    // A running .exe can't replace itself; guide the user to the installer instead.
    printManualGuidance(release);
    return;
  }

  const asset = assetName(release.version, platform);
  const archiveUrl = release.assets.get(asset);
  const sumsUrl = release.assets.get('SHA256SUMS.txt');
  if (!archiveUrl) throw new Error(`Release ${release.tag} has no asset ${asset}.`);
  if (!sumsUrl) throw new Error(`Release ${release.tag} has no SHA256SUMS.txt to verify against.`);

  // Work inside the install dir so the final rename is a same-filesystem atomic swap.
  const workDir = path.join(root, `.update-${process.pid}`);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    const archivePath = path.join(workDir, asset);
    console.log(`Downloading ${asset}…`);
    await download(archiveUrl, archivePath);
    const sumsPath = path.join(workDir, 'SHA256SUMS.txt');
    await download(sumsUrl, sumsPath);

    console.log('Verifying checksum…');
    const expected = parseSums(await readFile(sumsPath, 'utf8')).get(asset);
    if (!expected) throw new Error(`${asset} is not listed in SHA256SUMS.txt.`);
    const actual = await sha256File(archivePath);
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${asset}:\n  expected ${expected}\n  got      ${actual}`);
    }
    console.log('  ✓ sha256 verified');

    console.log('Extracting…');
    await execFileAsync('tar', ['xzf', archivePath, '-C', workDir]);

    const archiveRoot = await findArchiveRoot(workDir);
    const newBinary = await findBinary(archiveRoot);
    const newWeb = path.join(archiveRoot, 'web');
    if (!(await exists(newWeb))) throw new Error('Extracted archive is missing web/.');

    // Swap: replace the running binary (atomic rename over the same inode path)
    // and the adjacent web/ directory.
    await chmod(newBinary, 0o755);
    await rename(newBinary, targetBinary);
    await rm(path.join(root, 'web'), { recursive: true, force: true });
    await rename(newWeb, path.join(root, 'web'));

    // Best-effort: clear macOS quarantine so Gatekeeper doesn't flag the swap.
    if (process.platform === 'darwin') {
      await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', root]).catch(() => {});
    }

    console.log('');
    console.log(`✓ Updated to ${release.version}. Run \`dvalincode --version\` to confirm.`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ── npm: delegate to the package manager ─────────────────────────────────────

async function applyNpmUpdate(release: ReleaseInfo): Promise<void> {
  const spec = `dvalincode@${release.version}`;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log(`Running: npm install -g ${spec}`);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(npm, ['install', '-g', spec], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', c => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`npm exited with code ${code}.`);
  console.log(`✓ Updated to ${release.version}.`);
}

function printSourceGuidance(install: InstallInfo, release: ReleaseInfo): void {
  console.log('This looks like a source checkout — update it with git:');
  console.log(`  git -C ${install.root} pull`);
  console.log(`  npm install && npm run build   # rebuild at ${release.version}`);
}

function printManualGuidance(release: ReleaseInfo): void {
  console.log('Update by re-running the installer:');
  console.log(
    '  curl -fsSL https://raw.githubusercontent.com/' +
      RELEASE_REPO +
      '/main/scripts/install.sh | bash',
  );
  console.log('');
  console.log(`Or download ${release.version} manually: ${release.htmlUrl}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dvalincode-update' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

async function findArchiveRoot(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const match = entries.find(e => e.isDirectory() && e.name.startsWith('dvalincode-'));
  if (!match) throw new Error('Could not find the extracted dvalincode-* directory.');
  return path.join(dir, match.name);
}

async function findBinary(archiveRoot: string): Promise<string> {
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  const bin = entries.find(
    e => e.isFile() && e.name.startsWith('dvalincode-') && !e.name.endsWith('.sh') && !e.name.endsWith('.bat'),
  );
  if (!bin) throw new Error('Could not find the binary inside the extracted archive.');
  return path.join(archiveRoot, bin.name);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}
