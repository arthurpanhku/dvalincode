import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDvalinScanners, runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { consumeScannerWorkspaceGrant, issueScannerWorkspaceGrant } from '../src/server/scannerWorkspaceGrants.js';

describe.sequential('Dvalin scanner suite', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-scanner-suite-'));
    await writeFile(
      path.join(cwd, 'app.ts'),
      'const password = "production-secret-value";\nconst value = eval(input);\n',
      'utf8',
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs the built-in engine and returns quality metrics', async () => {
    const result = await runDvalinScanSuite(cwd, { scanners: ['builtin'] });

    expect(result.scanners).toEqual([
      expect.objectContaining({ id: 'builtin', status: 'completed', findings: 2 }),
    ]);
    expect(result.findings.map(finding => finding.ruleId)).toEqual(
      expect.arrayContaining(['dvalin/hardcoded-secret', 'dvalin/eval']),
    );
    expect(result.metrics.high).toBeGreaterThanOrEqual(2);
    expect(result.score).toBeLessThan(100);
    expect(result.grade).not.toBe('A');
  });

  it('reports optional engines as missing without failing the suite', async () => {
    vi.stubEnv('PATH', '');

    const scanners = await listDvalinScanners();
    const result = await runDvalinScanSuite(cwd, { scanners: ['semgrep', 'trivy', 'osv-scanner'] });

    expect(scanners.find(scanner => scanner.id === 'builtin')?.available).toBe(true);
    expect(scanners.filter(scanner => scanner.id !== 'builtin').every(scanner => !scanner.available)).toBe(true);
    expect(result.scanners).toHaveLength(3);
    expect(result.scanners.every(scanner => scanner.status === 'missing')).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('uses an explicit Semgrep community ruleset with metrics disabled', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-semgrep-'));
    const executable = path.join(bin, 'semgrep');
    await writeFile(executable, `#!/bin/sh
printf '%s\\n' "$@" > "$PWD/semgrep-args.txt"
output=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--output' ]; then output="$argument"; fi
  previous="$argument"
done
printf '%s' '{"version":"2.1.0","runs":[]}' > "$output"
`, 'utf8');
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', bin);

    const result = await runDvalinScanSuite(cwd, { scanners: ['semgrep'] });
    const args = await readFile(path.join(cwd, 'semgrep-args.txt'), 'utf8');

    expect(result.scanners).toEqual([
      expect.objectContaining({ id: 'semgrep', status: 'completed', findings: 0 }),
    ]);
    expect(args).toContain('p/default');
    expect(args).toContain('--metrics');
    expect(args).toContain('off');
    await rm(bin, { recursive: true, force: true });
  });

  it('treats an OSV scan without a supported manifest as a completed zero-result run', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-osv-'));
    const executable = path.join(bin, 'osv-scanner');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(executable, 0o755);
    vi.stubEnv('PATH', bin);

    const result = await runDvalinScanSuite(cwd, { scanners: ['osv-scanner'] });

    expect(result.scanners).toEqual([
      expect.objectContaining({ id: 'osv-scanner', status: 'completed', findings: 0 }),
    ]);
    await rm(bin, { recursive: true, force: true });
  });

  it('uses short-lived one-use workspace grants at the scanner API boundary', () => {
    const grant = issueScannerWorkspaceGrant(cwd);
    expect(consumeScannerWorkspaceGrant(grant)).toBe(cwd);
    expect(() => consumeScannerWorkspaceGrant(grant)).toThrow('invalid or expired');
    expect(() => consumeScannerWorkspaceGrant('/safe/../outside')).toThrow('invalid');
  });
});
