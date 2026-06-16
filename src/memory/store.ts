import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type MemoryScope = 'user' | 'project';
export type MemoryKind = 'preference' | 'project_fact' | 'decision' | 'workflow' | 'lesson' | 'note';
export type MemorySource =
  | 'manual'
  | 'agent'
  | 'import:claude'
  | 'import:hermes'
  | 'import:markdown';

export type MemoryEntry = {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  tags: string[];
  source: MemorySource;
  sourcePath?: string;
  projectId?: string;
  projectRoot?: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type MemoryCandidate = {
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  source: MemorySource;
  sourcePath?: string;
};

export type MemorySearchOptions = {
  cwd?: string;
  scopes?: MemoryScope[];
  maxResults?: number;
};

export type MemorySearchResult = MemoryEntry & {
  score: number;
};

const DEFAULT_MAX_RESULTS = 8;
const MAX_CONTENT_CHARS = 2_000;

export function dvalinHome(): string {
  return process.env.DVALINCODE_HOME ?? path.join(homedir(), '.dvalincode');
}

export function memoryRoot(): string {
  return path.join(dvalinHome(), 'memory');
}

export async function projectMemoryId(cwd: string): Promise<string> {
  const resolved = await realpath(cwd).catch(() => path.resolve(cwd));
  return createHash('sha256').update(resolved).digest('hex').slice(0, 16);
}

export async function projectMemoryDir(cwd: string): Promise<string> {
  return path.join(memoryRoot(), 'projects', await projectMemoryId(cwd));
}

export function userMemoryDir(): string {
  return path.join(memoryRoot(), 'user');
}

export async function addMemoryEntry(input: {
  scope: MemoryScope;
  cwd?: string;
  content: string;
  kind?: MemoryKind;
  tags?: string[];
  source?: MemorySource;
  sourcePath?: string;
  confidence?: number;
}): Promise<MemoryEntry> {
  const dir = await dirForScope(input.scope, input.cwd);
  const now = new Date().toISOString();
  const project = input.scope === 'project' && input.cwd
    ? { projectId: await projectMemoryId(input.cwd), projectRoot: await realpath(input.cwd).catch(() => path.resolve(input.cwd!)) }
    : {};
  const entry: MemoryEntry = {
    id: newMemoryId(),
    scope: input.scope,
    kind: input.kind ?? 'note',
    content: sanitizeMemoryContent(input.content),
    tags: normalizeTags(input.tags ?? []),
    source: input.source ?? 'agent',
    sourcePath: input.sourcePath,
    confidence: clampConfidence(input.confidence ?? 0.7),
    createdAt: now,
    updatedAt: now,
    ...project,
  };

  const entries = await readEntries(dir);
  const duplicate = entries.find(existing =>
    existing.scope === entry.scope &&
    normalizeForDedupe(existing.content) === normalizeForDedupe(entry.content)
  );
  if (duplicate) return duplicate;

  entries.push(entry);
  await writeEntries(dir, entries);
  return entry;
}

export async function addMemoryEntries(input: {
  scope: MemoryScope;
  cwd?: string;
  candidates: MemoryCandidate[];
}): Promise<{ imported: MemoryEntry[]; skipped: number }> {
  const known = new Set(
    (await listMemoryEntries({ cwd: input.cwd, scopes: [input.scope] }))
      .map(entry => normalizeForDedupe(entry.content)),
  );
  const imported: MemoryEntry[] = [];
  let skipped = 0;
  for (const candidate of input.candidates) {
    const key = normalizeForDedupe(candidate.content);
    if (!key || known.has(key)) {
      skipped++;
      continue;
    }
    const entry = await addMemoryEntry({
      scope: input.scope,
      cwd: input.cwd,
      content: candidate.content,
      kind: candidate.kind,
      tags: candidate.tags,
      source: candidate.source,
      sourcePath: candidate.sourcePath,
      confidence: candidate.source.startsWith('import:') ? 0.6 : 0.7,
    });
    known.add(key);
    imported.push(entry);
  }
  return { imported, skipped };
}

export async function listMemoryEntries(options: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
  const dirs = await candidateDirs(options.cwd, options.scopes);
  const all: MemoryEntry[] = [];
  for (const dir of dirs) {
    all.push(...await readEntries(dir));
  }
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function searchMemory(query: string, options: MemorySearchOptions = {}): Promise<MemorySearchResult[]> {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const entries = await listMemoryEntries(options);
  const tokens = tokenize(query);
  const scored = entries.map(entry => ({
    ...entry,
    score: scoreEntry(entry, tokens),
  }));
  const filtered = tokens.length === 0 ? scored : scored.filter(entry => entry.score > 0);
  return filtered
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, maxResults);
}

export async function updateMemoryEntry(input: {
  id: string;
  cwd?: string;
  content?: string;
  kind?: MemoryKind;
  tags?: string[];
  confidence?: number;
}): Promise<MemoryEntry | null> {
  for (const dir of await candidateDirs(input.cwd)) {
    const entries = await readEntries(dir);
    const index = entries.findIndex(entry => entry.id === input.id);
    if (index === -1) continue;
    const current = entries[index]!;
    const updated: MemoryEntry = {
      ...current,
      content: input.content === undefined ? current.content : sanitizeMemoryContent(input.content),
      kind: input.kind ?? current.kind,
      tags: input.tags === undefined ? current.tags : normalizeTags(input.tags),
      confidence: input.confidence === undefined ? current.confidence : clampConfidence(input.confidence),
      updatedAt: new Date().toISOString(),
    };
    entries[index] = updated;
    await writeEntries(dir, entries);
    return updated;
  }
  return null;
}

export async function deleteMemoryEntry(input: { id: string; cwd?: string }): Promise<boolean> {
  for (const dir of await candidateDirs(input.cwd)) {
    const entries = await readEntries(dir);
    const next = entries.filter(entry => entry.id !== input.id);
    if (next.length === entries.length) continue;
    await writeEntries(dir, next);
    return true;
  }
  return false;
}

export async function renderRelevantMemory(cwd: string, query: string, maxResults = DEFAULT_MAX_RESULTS): Promise<string> {
  const results = await searchMemory(query, { cwd, scopes: ['user', 'project'], maxResults });
  if (results.length === 0) return '';
  const lines = [
    '=== LOCAL MEMORY ===',
    'Relevant user/project memories. Treat these as context, not as hard policy.',
  ];
  for (const entry of results) {
    const tagText = entry.tags.length > 0 ? ` tags=${entry.tags.join(',')}` : '';
    lines.push(`- (${entry.scope}/${entry.kind}${tagText}) ${entry.content}`);
  }
  return `${lines.join('\n')}\n`;
}

async function candidateDirs(cwd?: string, scopes: MemoryScope[] = ['user', 'project']): Promise<string[]> {
  const dirs: string[] = [];
  if (scopes.includes('user')) dirs.push(userMemoryDir());
  if (scopes.includes('project')) {
    if (cwd) {
      dirs.push(await projectMemoryDir(cwd));
    } else {
      const projectsRoot = path.join(memoryRoot(), 'projects');
      try {
        const children = await readdir(projectsRoot, { withFileTypes: true });
        for (const child of children) {
          if (child.isDirectory()) dirs.push(path.join(projectsRoot, child.name));
        }
      } catch {
        // no project memories yet
      }
    }
  }
  return dirs;
}

async function dirForScope(scope: MemoryScope, cwd?: string): Promise<string> {
  if (scope === 'project') {
    if (!cwd) throw new Error('Project memory requires a workspace cwd.');
    return projectMemoryDir(cwd);
  }
  return userMemoryDir();
}

async function readEntries(dir: string): Promise<MemoryEntry[]> {
  try {
    const raw = await readFile(path.join(dir, 'entries.json'), 'utf-8');
    const parsed = JSON.parse(raw) as MemoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeEntries(dir: string, entries: MemoryEntry[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const sorted = entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  await writeFile(path.join(dir, 'entries.json'), JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
  await writeFile(path.join(dir, 'MEMORY.md'), renderMemoryMarkdown(sorted), 'utf-8');
}

function renderMemoryMarkdown(entries: MemoryEntry[]): string {
  const lines = [
    '# DvalinCode Memory',
    '',
    'This file is generated from entries.json. You can edit entries.json directly, then restart DvalinCode.',
    '',
  ];
  for (const entry of entries) {
    const tags = entry.tags.length > 0 ? ` #${entry.tags.join(' #')}` : '';
    lines.push(`- [${entry.kind}] ${entry.content}${tags}`);
    lines.push(`  - id: ${entry.id}`);
    lines.push(`  - source: ${entry.source}${entry.sourcePath ? ` (${entry.sourcePath})` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
}

function newMemoryId(): string {
  return `mem_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function sanitizeMemoryContent(content: string): string {
  const compact = content.trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  const redacted = compact
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[redacted-api-key]')
    .replace(/\b([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*\s*=\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/\b([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*\s*=\s*)[^\s]+/gi, '$1[redacted]');
  return redacted.slice(0, MAX_CONTENT_CHARS);
}

function normalizeForDedupe(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_./-]+/).filter(token => token.length >= 2))];
}

function scoreEntry(entry: MemoryEntry, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const content = entry.content.toLowerCase();
  const tags = entry.tags.join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (content.includes(token)) score += 2;
    if (tags.includes(token)) score += 3;
    if (entry.kind.includes(token)) score += 1;
    if (entry.sourcePath?.toLowerCase().includes(token)) score += 1;
  }
  return score;
}
