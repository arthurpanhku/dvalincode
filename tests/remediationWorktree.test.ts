import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemediationWorktree, remediationBranchName } from '../src/remediation/worktree.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';

const execAsync = promisify(execFile);

describe('remediation worktrees', () => {
  let root: string;
  let home: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dvalin-remediation-repo-'));
    home = await mkdtemp(path.join(tmpdir(), 'dvalin-remediation-home-'));
    originalHome = process.env.DVALINCODE_HOME;
    process.env.DVALINCODE_HOME = home;

    await execAsync('git', ['init'], { cwd: root });
    await execAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execAsync('git', ['config', 'user.name', 'Test User'], { cwd: root });
    await writeFile(path.join(root, 'app.ts'), 'const ok = true;\n', 'utf8');
    await execAsync('git', ['add', 'app.ts'], { cwd: root });
    await execAsync('git', ['commit', '-m', 'initial'], { cwd: root });
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.DVALINCODE_HOME;
    } else {
      process.env.DVALINCODE_HOME = originalHome;
    }
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('creates a safe remediation branch name', () => {
    const branch = remediationBranchName(finding(), new Date('2026-06-30T00:00:00Z'));

    expect(branch).toMatch(/^dvalin\/remediate\/20260630-/);
    expect(branch).toContain('dvalin-sql-string-concatenation-src-user-service-ts');
    expect(branch).not.toContain('..');
  });

  it('creates an isolated git worktree with a remediation prompt', async () => {
    const result = await createRemediationWorktree(root, finding());
    const { stdout: branch } = await execAsync('git', ['branch', '--show-current'], { cwd: result.cwd });

    expect(branch.trim()).toBe(result.branch);
    expect(result.cwd).toContain(path.join(home, 'projects', 'remediations'));
    expect(result.prompt).toContain('Secure remediation task in isolated worktree');
    expect(result.prompt).toContain(result.cwd);
  });
});

function finding(): RemediationFinding {
  return {
    id: 'finding-12345678',
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/sql-string-concatenation',
    severity: 'error',
    securitySeverity: '8.8',
    message: 'SQL appears to be built with string concatenation.',
    path: 'src/user service.ts',
    startLine: 42,
    tags: ['security', 'sql-injection'],
    prompt: 'Secure remediation task:\n\nFix SQL injection.',
  };
}
