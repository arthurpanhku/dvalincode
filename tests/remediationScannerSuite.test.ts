import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dvalinScannerInstallPlan, listDvalinScanners, runDvalinScanSuite } from '../src/remediation/scannerSuite.js';
import { consumeScannerWorkspaceGrant, issueScannerWorkspaceGrant } from '../src/server/scannerWorkspaceGrants.js';

/**
 * Put a fake scanner named `name` in `bin`. The behaviour is a Node script so it
 * runs on every platform; only the launcher differs.
 *
 * Scanners are spawned without a shell, and on Windows that finds only real
 * `.exe` files, so a `.cmd` shim would never run. Instead the launcher is a copy
 * of node.exe under the scanner's name, with NODE_OPTIONS preloading the script.
 * Node takes the scanner's first argument (`scan`) as its entry point, but the
 * preload exits before that is ever loaded. Everywhere else it is a shell script.
 */
async function writeFakeScanner(bin: string, name: string, script: string): Promise<void> {
  const scriptPath = path.join(bin, `${name}.cjs`);
  await writeFile(scriptPath, `${script}\nprocess.exit(0);\n`, 'utf8');
  if (process.platform === 'win32') {
    await copyFile(process.execPath, path.join(bin, `${name}.exe`));
    // NODE_OPTIONS reads backslashes in a quoted value as escapes.
    vi.stubEnv('NODE_OPTIONS', `--require ${JSON.stringify(scriptPath)}`);
    return;
  }
  const executable = path.join(bin, name);
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
  await chmod(executable, 0o755);
}

describe('Dvalin scanner suite', { concurrent: false }, () => {
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

  it('returns a reviewable install plan without executing it', () => {
    expect(dvalinScannerInstallPlan('builtin')).toMatchObject({ supported: true, reason: expect.stringContaining('no installation') });
    expect(dvalinScannerInstallPlan('semgrep')).toEqual({
      scanner: 'semgrep', supported: true, command: 'python3 -m pip install semgrep',
    });
  });

  it('uses an explicit Semgrep community ruleset with metrics disabled', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-semgrep-'));
    await writeFakeScanner(bin, 'semgrep', `const { writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
writeFileSync(path.join(process.cwd(), 'semgrep-args.txt'), args.map(arg => arg + '\\n').join(''));
writeFileSync(args[args.indexOf('--output') + 1], '{"version":"2.1.0","runs":[]}');
`);
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
    await writeFakeScanner(bin, 'osv-scanner', '');
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
