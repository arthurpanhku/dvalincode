import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLocalSecurityScan } from '../src/remediation/localScan.js';

describe('runLocalSecurityScan', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-local-scan-'));
    await mkdir(path.join(cwd, 'src'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('finds common local security risks and builds remediation prompts', async () => {
    await writeFile(
      path.join(cwd, 'src', 'server.ts'),
      [
        'import { exec } from "node:child_process";',
        'const apiKey = "sk-live-1234567890abcdef";', // scanner fixture
        'app.get("/user", (req, res) => {',
        '  const sql = "SELECT * FROM users WHERE name = " + req.query.name;', // scanner fixture
        '  exec("grep " + req.query.name);', // scanner fixture
        '});',
      ].join('\n'),
      'utf8',
    );

    const result = await runLocalSecurityScan(cwd);
    const rules = result.findings.map(finding => finding.ruleId);

    expect(result.source).toBe('Dvalin Local Scan');
    expect(result.totalResults).toBeGreaterThanOrEqual(3);
    expect(rules).toContain('dvalin/hardcoded-secret');
    expect(rules).toContain('dvalin/sql-string-concatenation');
    expect(rules).toContain('dvalin/shell-command-injection');
    expect(result.findings[0].prompt).toContain('Secure remediation task');
    expect(result.findings.some(finding => finding.snippet?.includes('SELECT * FROM users'))).toBe(true);
  });

  it('skips placeholder values and files ignored by .dvalincodeignore', async () => {
    await writeFile(path.join(cwd, '.dvalincodeignore'), 'src/ignored.ts\n', 'utf8');
    await writeFile(
      path.join(cwd, 'src', 'ignored.ts'),
      'const token = "real-looking-secret-value";\n', // scanner fixture
      'utf8',
    );
    await writeFile(
      path.join(cwd, 'src', 'safe.ts'),
      'const apiKey = "example-placeholder-value";\n',
      'utf8',
    );

    const result = await runLocalSecurityScan(cwd);

    expect(result.findings).toEqual([]);
  });
});
