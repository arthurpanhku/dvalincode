import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

  /**
   * Fakes that record when they ran and what they were given, one file per
   * engine so concurrent runs never interleave writes. The engine name comes
   * from the launcher, so one script serves every fake.
   */
  async function writeRecordingScanners(bin: string, names: string[], busyMs: number): Promise<void> {
    for (const name of names) {
      await writeFakeScanner(bin, name, `const { writeFileSync } = require('node:fs');
const path = require('node:path');
const name = process.platform === 'win32' ? path.basename(process.execPath, '.exe') : path.basename(process.argv[1], '.cjs');
const args = process.argv.slice(2);
const start = Date.now();
while (Date.now() - start < ${busyMs}) { /* busy: a stand-in for real analysis */ }
const flag = args.find(arg => arg.startsWith('--sarif-file-output='));
const output = flag ? flag.split('=')[1] : args[args.findIndex(arg => arg === '--output' || arg === '--output-file') + 1];
const id = name === 'snyk' ? (args[0] === 'code' ? 'snyk-code' : 'snyk-oss') : name;
writeFileSync(path.join(process.cwd(), 'ran-' + id + '.json'), JSON.stringify({ start, end: Date.now(), args }));
if (output) writeFileSync(output, '{"version":"2.1.0","runs":[]}');
`);
    }
  }

  async function ran(id: string): Promise<{ start: number; end: number; args: string[] }> {
    return JSON.parse(await readFile(path.join(cwd, `ran-${id}.json`), 'utf8'));
  }

  const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

  it('runs engines side by side, the two Snyk engines in turn, and reports in a fixed order', async () => {
    const bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-parallel-'));
    await writeRecordingScanners(bin, ['semgrep', 'trivy', 'osv-scanner', 'snyk'], 600);
    vi.stubEnv('PATH', bin);

    const result = await runDvalinScanSuite(cwd, { scanners: ['snyk-oss', 'osv-scanner', 'builtin', 'semgrep', 'trivy', 'snyk-code'] });

    expect(result.scanners.map(run => run.id)).toEqual(['builtin', 'semgrep', 'trivy', 'osv-scanner', 'snyk-code', 'snyk-oss']);
    expect(result.scanners.every(run => run.status === 'completed')).toBe(true);
    const [semgrep, trivy, osv, snykCode, snykOss] = await Promise.all(
      ['semgrep', 'trivy', 'osv-scanner', 'snyk-code', 'snyk-oss'].map(ran),
    );
    expect(overlap(semgrep, trivy) && overlap(trivy, osv) && overlap(semgrep, osv)).toBe(true);
    // One executable, one process at a time.
    expect(overlap(snykCode, snykOss)).toBe(false);
    await rm(bin, { recursive: true, force: true });
  });

  it('narrows only the per-file engines, and only to files that exist', async () => {
    await writeFile(path.join(cwd, 'other.ts'), 'export const run = (input: string) => eval(input);\n', 'utf8');
    const bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-narrow-'));
    await writeRecordingScanners(bin, ['semgrep', 'trivy'], 0);
    vi.stubEnv('PATH', bin);

    const result = await runDvalinScanSuite(cwd, {
      scanners: ['builtin', 'semgrep', 'trivy'],
      narrow: { files: ['other.ts', 'deleted.ts', '../outside.ts'] },
    });

    expect(result.narrowed).toEqual({ files: 1, engines: ['builtin', 'semgrep'] });
    // Built-in looked at other.ts only: app.ts's two findings are not re-reported.
    expect(result.findings.map(finding => finding.path)).toEqual(['other.ts']);
    const semgrep = await ran('semgrep');
    const trivy = await ran('trivy');
    // Narrowed with an anchored --include on the root, so Semgrep's own ignore
    // rules still apply; naming the file as a target would bypass them.
    expect(semgrep.args.at(-1)).toBe(await realpath(cwd));
    expect(semgrep.args.filter((_, index) => semgrep.args[index - 1] === '--include')).toEqual(['/other.ts']);
    // Trivy is not per-file: it still scans the whole root.
    expect(trivy.args.at(-1)).toBe(await realpath(cwd));
    await rm(bin, { recursive: true, force: true });
  });

  it('scans in full when there is nothing left to narrow to', async () => {
    const result = await runDvalinScanSuite(cwd, { scanners: ['builtin'], narrow: { files: ['deleted.ts'] } });
    expect(result.narrowed).toBeUndefined();
    expect(result.findings.map(finding => finding.ruleId)).toEqual(
      expect.arrayContaining(['dvalin/hardcoded-secret', 'dvalin/eval']),
    );
  });

  it('uses short-lived one-use workspace grants at the scanner API boundary', () => {
    const grant = issueScannerWorkspaceGrant(cwd);
    expect(consumeScannerWorkspaceGrant(grant)).toBe(cwd);
    expect(() => consumeScannerWorkspaceGrant(grant)).toThrow('invalid or expired');
    expect(() => consumeScannerWorkspaceGrant('/safe/../outside')).toThrow('invalid');
  });
});
