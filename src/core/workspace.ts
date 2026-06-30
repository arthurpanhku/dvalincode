import { realpath } from 'node:fs/promises';
import path from 'node:path';

function normalizeBasePath(cwd: string): string {
  if (!cwd || cwd.includes('\0')) {
    throw new Error('Workspace path is invalid');
  }
  return path.resolve(cwd);
}

export function isInsidePath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertInsidePath(root: string, target: string, label = target): string {
  if (!isInsidePath(root, target)) {
    throw new Error(`Path escapes workspace: ${label}`);
  }
  return target;
}

export async function resolveWorkspaceRoot(cwd: string): Promise<string> {
  const normalized = normalizeBasePath(cwd);
  return realpath(normalized);
}

export function resolveRelativeInside(root: string, inputPath: string): string {
  if (!inputPath || inputPath.includes('\0') || path.isAbsolute(inputPath)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return assertInsidePath(root, path.resolve(root, inputPath), inputPath);
}

/**
 * Resolve a user-provided path and ensure it stays inside the workspace.
 * Resolves symlinks to prevent symbolic-link-based path traversal.
 */
export async function resolveInsideWorkspace(cwd: string, inputPath: string): Promise<string> {
  const root = await resolveWorkspaceRoot(cwd);
  // Resolve the target relative to the resolved root
  const target = resolveRelativeInside(root, inputPath);
  const resolvedTarget = await realpath(target).catch(async () => {
    // Target doesn't exist yet — walk up the tree to find the nearest existing ancestor.
    let ancestor = path.dirname(target);
    const segments: string[] = [path.basename(target)];
    while (ancestor !== path.dirname(ancestor)) {
      try {
        const resolvedAncestor = await realpath(ancestor);
        return path.join(resolvedAncestor, ...segments);
      } catch {
        segments.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    throw new Error(`Cannot resolve path: no existing ancestor found for ${target}`);
  });
  return assertInsidePath(root, resolvedTarget, inputPath);
}
