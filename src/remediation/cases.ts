import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dvalinHome } from '../memory/store.js';
import type { RemediationFinding } from './sarif.js';

export type RemediationCaseStatus = 'open' | 'worktree_ready' | 'fixing' | 'verified' | 'dismissed';

export type RemediationCase = {
  id: string;
  findingId: string;
  source: string;
  cwd?: string;
  ruleId: string;
  severity: RemediationFinding['severity'];
  securitySeverity?: string;
  message: string;
  path: string;
  startLine?: number;
  tags: string[];
  prompt: string;
  status: RemediationCaseStatus;
  worktreeCwd?: string;
  branch?: string;
  createdAt: string;
  updatedAt: string;
};

export type RemediationCasePatch = {
  status?: RemediationCaseStatus;
  worktreeCwd?: string;
  branch?: string;
  prompt?: string;
};

function casesFile(): string {
  return path.join(dvalinHome(), 'remediation', 'cases.json');
}

function caseId(cwd: string | undefined, finding: RemediationFinding): string {
  const hash = createHash('sha256')
    .update([cwd ?? '', finding.source, finding.id, finding.ruleId, finding.path, finding.startLine ?? ''].join('\0'))
    .digest('hex')
    .slice(0, 16);
  return `rem_${hash}`;
}

async function readCases(): Promise<RemediationCase[]> {
  try {
    const raw = await readFile(casesFile(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as RemediationCase[] : [];
  } catch {
    return [];
  }
}

async function writeCases(cases: RemediationCase[]): Promise<void> {
  const file = casesFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cases, null, 2) + '\n', 'utf-8');
}

export async function listRemediationCases(opts: { cwd?: string; limit?: number } = {}): Promise<RemediationCase[]> {
  const limit = opts.limit ?? 50;
  const cases = await readCases();
  return cases
    .filter(item => !opts.cwd || item.cwd === opts.cwd)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

export async function getRemediationCase(id: string): Promise<RemediationCase | undefined> {
  const cases = await readCases();
  return cases.find(item => item.id === id);
}

export async function upsertRemediationCases(input: {
  cwd?: string;
  findings: RemediationFinding[];
}): Promise<RemediationCase[]> {
  const existing = await readCases();
  const byId = new Map(existing.map(item => [item.id, item]));
  const now = new Date().toISOString();
  const changed: RemediationCase[] = [];

  for (const finding of input.findings) {
    const id = caseId(input.cwd, finding);
    const previous = byId.get(id);
    const next: RemediationCase = {
      id,
      findingId: finding.id,
      source: finding.source,
      cwd: input.cwd,
      ruleId: finding.ruleId,
      severity: finding.severity,
      securitySeverity: finding.securitySeverity,
      message: finding.message,
      path: finding.path,
      startLine: finding.startLine,
      tags: finding.tags,
      prompt: previous?.prompt ?? finding.prompt,
      status: previous?.status ?? 'open',
      worktreeCwd: previous?.worktreeCwd,
      branch: previous?.branch,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    byId.set(id, next);
    changed.push(next);
  }

  await writeCases([...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  return changed;
}

export async function updateRemediationCase(id: string, patch: RemediationCasePatch): Promise<RemediationCase> {
  const cases = await readCases();
  const index = cases.findIndex(item => item.id === id);
  if (index === -1) throw new Error(`Remediation case not found: ${id}`);

  const current = cases[index]!;
  const next: RemediationCase = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  cases[index] = next;
  await writeCases(cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  return next;
}
