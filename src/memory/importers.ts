import { stat, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { MemoryCandidate, MemoryScope, MemorySource } from './store.js';
import { addMemoryEntries } from './store.js';

export type MemoryImportSource = 'claude' | 'hermes' | 'markdown';

export type MemoryImportOptions = {
  source: MemoryImportSource;
  sourcePath?: string;
  cwd?: string;
  scope?: MemoryScope;
  dryRun?: boolean;
};

export type MemoryImportResult = {
  source: MemoryImportSource;
  scope: MemoryScope;
  candidates: MemoryCandidate[];
  imported: number;
  skipped: number;
};

export async function importMemory(options: MemoryImportOptions): Promise<MemoryImportResult> {
  const scope = options.scope ?? defaultScope(options.source);
  const candidates = await collectCandidates(options);
  if (options.dryRun) {
    return { source: options.source, scope, candidates, imported: 0, skipped: 0 };
  }
  const result = await addMemoryEntries({ scope, cwd: options.cwd, candidates });
  return {
    source: options.source,
    scope,
    candidates,
    imported: result.imported.length,
    skipped: result.skipped,
  };
}

async function collectCandidates(options: MemoryImportOptions): Promise<MemoryCandidate[]> {
  switch (options.source) {
    case 'claude':
      return collectClaudeCandidates(options.sourcePath, options.cwd);
    case 'hermes':
      return collectHermesCandidates(options.sourcePath);
    case 'markdown':
      if (!options.sourcePath) throw new Error('markdown import requires sourcePath');
      return collectMarkdownCandidates([options.sourcePath], 'import:markdown');
  }
}

async function collectClaudeCandidates(sourcePath: string | undefined, cwd: string | undefined): Promise<MemoryCandidate[]> {
  const paths = sourcePath ? [sourcePath] : await defaultClaudePaths(cwd);
  return collectMarkdownCandidates(paths, 'import:claude');
}

async function collectHermesCandidates(sourcePath: string | undefined): Promise<MemoryCandidate[]> {
  const base = sourcePath ?? path.join(homedir(), '.hermes', 'memories');
  return collectMarkdownCandidates([base], 'import:hermes');
}

async function defaultClaudePaths(cwd: string | undefined): Promise<string[]> {
  const paths: string[] = [];
  if (cwd) {
    paths.push(path.join(cwd, 'CLAUDE.md'));
    paths.push(path.join(cwd, 'CLAUDE.local.md'));
    const discovered = await findClaudeProjectMemoryDir(cwd);
    if (discovered) paths.push(discovered);
  }
  paths.push(path.join(homedir(), '.claude', 'CLAUDE.md'));
  return paths;
}

async function findClaudeProjectMemoryDir(cwd: string): Promise<string | undefined> {
  const projectsRoot = path.join(homedir(), '.claude', 'projects');
  const basename = path.basename(cwd).toLowerCase();
  try {
    const children = await readdir(projectsRoot, { withFileTypes: true });
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const dirName = child.name.toLowerCase();
      if (!dirName.includes(basename)) continue;
      const memoryDir = path.join(projectsRoot, child.name, 'memory');
      if (await exists(path.join(memoryDir, 'MEMORY.md'))) return memoryDir;
    }
  } catch {
    // Claude may not be installed or may not have auto-memory yet.
  }
  return undefined;
}

async function collectMarkdownCandidates(paths: string[], source: MemorySource): Promise<MemoryCandidate[]> {
  const files: string[] = [];
  for (const p of paths) {
    files.push(...await markdownFiles(p));
  }

  const candidates: MemoryCandidate[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf-8').catch(() => '');
    for (const chunk of splitMarkdownMemory(text)) {
      candidates.push({
        content: chunk,
        kind: inferKind(chunk, file),
        tags: inferTags(chunk, file),
        source,
        sourcePath: file,
      });
    }
  }
  return dedupeCandidates(candidates);
}

async function markdownFiles(input: string): Promise<string[]> {
  if (!await exists(input)) return [];
  const info = await stat(input);
  if (info.isFile()) return input.toLowerCase().endsWith('.md') ? [input] : [];
  if (!info.isDirectory()) return [];
  const files: string[] = [];
  const children = await readdir(input, { withFileTypes: true });
  for (const child of children) {
    const childPath = path.join(input, child.name);
    if (child.isFile() && child.name.toLowerCase().endsWith('.md')) {
      files.push(childPath);
    }
  }
  return files.sort();
}

function splitMarkdownMemory(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.includes('§')) {
    return normalized.split('§').map(cleanChunk).filter(Boolean);
  }

  const bullets = normalized
    .split('\n')
    .map(line => line.match(/^\s*[-*]\s+(.+)$/)?.[1] ?? '')
    .map(cleanChunk)
    .filter(Boolean);
  if (bullets.length > 0) return bullets;

  return normalized
    .split(/\n{2,}/)
    .map(cleanChunk)
    .filter(Boolean);
}

function cleanChunk(input: string): string {
  const text = input
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
    .trim();
  if (!text || text.startsWith('```')) return '';
  if (/^(id|source|updated|created):/i.test(text)) return '';
  return text.length > 1_800 ? `${text.slice(0, 1_800).trim()}...` : text;
}

function inferKind(content: string, file: string): MemoryCandidate['kind'] {
  const lower = `${file}\n${content}`.toLowerCase();
  if (lower.includes('prefer') || lower.includes('preference')) return 'preference';
  if (lower.includes('command') || lower.includes('workflow') || lower.includes('run ')) return 'workflow';
  if (lower.includes('decision') || lower.includes('adr')) return 'decision';
  if (lower.includes('bug') || lower.includes('lesson') || lower.includes('pitfall')) return 'lesson';
  return 'note';
}

function inferTags(content: string, file: string): string[] {
  const tags = new Set<string>();
  const base = path.basename(file, path.extname(file)).toLowerCase();
  if (base && base !== 'memory') tags.add(base);
  for (const token of content.toLowerCase().match(/\b(test|build|deploy|api|database|frontend|backend|security|git|docker|python|typescript)\b/g) ?? []) {
    tags.add(token);
  }
  return [...tags].slice(0, 6);
}

function dedupeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  const result: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.content.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function defaultScope(source: MemoryImportSource): MemoryScope {
  return source === 'hermes' ? 'user' : 'project';
}

async function exists(input: string): Promise<boolean> {
  try {
    await stat(input);
    return true;
  } catch {
    return false;
  }
}
