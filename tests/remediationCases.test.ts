import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRemediationCases, updateRemediationCase, upsertRemediationCases } from '../src/remediation/cases.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';

describe('remediation cases', () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dvalin-remediation-cases-'));
    originalHome = process.env.DVALINCODE_HOME;
    process.env.DVALINCODE_HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.DVALINCODE_HOME;
    } else {
      process.env.DVALINCODE_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('persists findings as stable remediation cases', async () => {
    const [first] = await upsertRemediationCases({ cwd: '/repo', findings: [finding()] });
    const [second] = await upsertRemediationCases({ cwd: '/repo', findings: [finding()] });
    const cases = await listRemediationCases({ cwd: '/repo' });

    expect(first.id).toBe(second.id);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      findingId: 'finding-1',
      ruleId: 'dvalin/sql-string-concatenation',
      status: 'open',
      cwd: '/repo',
    });
  });

  it('updates case status and filters by workspace', async () => {
    const [repoCase] = await upsertRemediationCases({ cwd: '/repo', findings: [finding()] });
    await upsertRemediationCases({ cwd: '/other', findings: [{ ...finding(), id: 'finding-2', path: 'src/other.ts' }] });

    const updated = await updateRemediationCase(repoCase.id, {
      status: 'worktree_ready',
      branch: 'dvalin/remediate/test',
      worktreeCwd: '/repo-worktree',
    });
    const repoCases = await listRemediationCases({ cwd: '/repo' });

    expect(updated.status).toBe('worktree_ready');
    expect(repoCases).toHaveLength(1);
    expect(repoCases[0].branch).toBe('dvalin/remediate/test');
  });
});

function finding(): RemediationFinding {
  return {
    id: 'finding-1',
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/sql-string-concatenation',
    severity: 'error',
    securitySeverity: '8.8',
    message: 'SQL appears to be built with string concatenation.',
    path: 'src/server.ts',
    startLine: 10,
    tags: ['security'],
    prompt: 'Secure remediation task.',
  };
}
