import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWorkspaceRoot } from './workspace.js';

/** Whether a workspace-relative path is excluded by a .dvalincodeignore pattern (read_file's rules). */
export function isIgnoredPath(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return patterns.some(
    pattern =>
      normalized === pattern ||
      normalized.endsWith('/' + pattern) ||
      normalized.includes('/' + pattern + '/') ||
      normalized.startsWith(pattern + '/'),
  );
}

export async function loadIgnorePatterns(cwd: string): Promise<string[]> {
  try {
    const root = await resolveWorkspaceRoot(cwd);
    const content = await readFile(join(root, '.dvalincodeignore'), 'utf8');
    return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}
