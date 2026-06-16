import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { dvalinHome } from '../memory/store.js';

/**
 * Portable backup of everything DvalinCode stores locally under ~/.dvalincode
 * (config, profiles, sessions, memory, audit logs, project metadata). Used to
 * migrate a setup to another machine: export → copy the file → import.
 *
 * All DvalinCode data is UTF-8 text (JSON / JSONL / Markdown), so the bundle is
 * a simple relative-path → content map — dependency-free and human-inspectable.
 */
export const DATA_BUNDLE_VERSION = 1;

export type DataBundle = {
  app: 'dvalincode';
  version: number;
  exportedAt: string;
  /** Map of paths relative to ~/.dvalincode → UTF-8 file contents. */
  files: Record<string, string>;
};

export type ExportOptions = {
  /** Base dir to export (defaults to ~/.dvalincode). */
  home?: string;
  /** Include the audit/ run logs (can be large). Default: true. */
  includeAudit?: boolean;
};

export type ImportOptions = {
  /** Base dir to restore into (defaults to ~/.dvalincode). */
  home?: string;
  /** Overwrite files that already exist. Default: true (it's a restore). */
  overwrite?: boolean;
};

export type ImportResult = {
  written: number;
  skipped: number;
  total: number;
};

const MAX_FILE_BYTES = 25 * 1024 * 1024; // skip anything implausibly large

/** Collect all local data into a portable bundle. */
export async function exportData(options: ExportOptions = {}): Promise<DataBundle> {
  const home = options.home ?? dvalinHome();
  const includeAudit = options.includeAudit ?? true;
  const files: Record<string, string> = {};

  for await (const rel of walk(home, '')) {
    const top = rel.split('/')[0];
    if (!includeAudit && top === 'audit') continue;

    const abs = path.join(home, rel);
    let info;
    try {
      info = await stat(abs);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;

    try {
      // utf-8 read; binary files (none expected) would round-trip lossily, so skip.
      const content = await readFile(abs, 'utf-8');
      files[rel] = content;
    } catch {
      // unreadable / non-text — skip rather than abort the whole export
    }
  }

  return {
    app: 'dvalincode',
    version: DATA_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    files,
  };
}

/** Validate a parsed object is a DvalinCode data bundle. */
export function isDataBundle(value: unknown): value is DataBundle {
  if (!value || typeof value !== 'object') return false;
  const b = value as Partial<DataBundle>;
  return b.app === 'dvalincode' && typeof b.version === 'number' && !!b.files && typeof b.files === 'object';
}

/** Restore a bundle into ~/.dvalincode. Paths are sanitized to stay inside home. */
export async function importData(bundle: DataBundle, options: ImportOptions = {}): Promise<ImportResult> {
  if (!isDataBundle(bundle)) {
    throw new Error('Not a valid DvalinCode data bundle.');
  }
  if (bundle.version > DATA_BUNDLE_VERSION) {
    throw new Error(`Bundle version ${bundle.version} is newer than this build supports (${DATA_BUNDLE_VERSION}).`);
  }

  const home = options.home ?? dvalinHome();
  const overwrite = options.overwrite ?? true;
  const entries = Object.entries(bundle.files);
  let written = 0;
  let skipped = 0;

  for (const [rel, content] of entries) {
    const safeRel = sanitizeRelPath(rel);
    if (!safeRel) {
      skipped++;
      continue;
    }
    const abs = path.join(home, safeRel);

    if (!overwrite && (await exists(abs))) {
      skipped++;
      continue;
    }

    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
    written++;
  }

  return { written, skipped, total: entries.length };
}

/** Reject absolute paths and `..` traversal; normalize separators. */
function sanitizeRelPath(rel: string): string | null {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) return null;
  const parts = normalized.split('/');
  if (parts.some(p => p === '..' || p === '.')) return null;
  return parts.join(path.sep);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursively yield file paths relative to `base`, skipping dotfiles like .DS_Store. */
async function* walk(base: string, rel: string): AsyncGenerator<string> {
  const dir = path.join(base, rel);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (dirent.name === '.DS_Store') continue;
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      yield* walk(base, childRel);
    } else if (dirent.isFile()) {
      yield childRel;
    }
  }
}
