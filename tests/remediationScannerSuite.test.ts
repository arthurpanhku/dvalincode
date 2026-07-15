import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDvalinScanners, runDvalinScanSuite } from '../src/remediation/scannerSuite.js';

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
});
