import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveWorkspaceRoot } from './workspace.js';

export async function loadIgnorePatterns(cwd: string): Promise<string[]> {
  try {
    const root = await resolveWorkspaceRoot(cwd);
    const content = await readFile(join(root, '.dvalincodeignore'), 'utf8');
    return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}
