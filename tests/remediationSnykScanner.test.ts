import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SCANNER_IDS,
  dvalinScannerInstallPlan,
  listDvalinScanners,
  runDvalinScanSuite,
} from '../src/remediation/scannerSuite.js';
import { deriveCoverage, scannerIdForSource, snapshotFinding } from '../src/security/contracts.js';
import { parseSecurityConfig } from '../src/security/config.js';

/** Same launcher as tests/remediationScannerSuite.test.ts: a Node script under the scanner's name. */
async function writeFakeScanner(bin: string, name: string, script: string): Promise<void> {
  const scriptPath = path.join(bin, `${name}.cjs`);
  await writeFile(scriptPath, `${script}\nprocess.exit(0);\n`, 'utf8');
  if (process.platform === 'win32') {
    await copyFile(process.execPath, path.join(bin, `${name}.exe`));
    vi.stubEnv('NODE_OPTIONS', `--require ${JSON.stringify(scriptPath)}`);
    return;
  }
  const executable = path.join(bin, name);
  await writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
  await chmod(executable, 0o755);
}

/**
 * A fake `snyk` that answers `snyk code test` and `snyk test` with the SARIF
 * shapes the real CLI emits: driver names "SnykCode" and "Snyk Open Source",
 * `security-severity` on the rule, an ignored issue carried as a SARIF
 * suppression, and exit 1 when issues were found.
 */
const FAKE_SNYK = String.raw`
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
writeFileSync(path.join(process.cwd(), 'snyk-args-' + args[0] + '.txt'), args.join('\n'));
const out = (args.find(arg => arg.startsWith('--sarif-file-output=')) || '').slice('--sarif-file-output='.length);
const mode = process.env.FAKE_SNYK_MODE || 'issues';
if (mode === 'auth') { console.error('Authentication failed. Run snyk auth.'); process.exit(2); }
if (mode === 'unsupported') { process.exit(3); }
const code = args[0] === 'code';
const run = code
  ? {
      tool: { driver: { name: 'SnykCode', rules: [
        { id: 'javascript/CodeInjection', name: 'CodeInjection', properties: { tags: ['security'], 'security-severity': '8.6' } },
      ] } },
      results: [
        { ruleId: 'javascript/CodeInjection', level: 'error', message: { text: 'Unsanitized input flows into eval' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js' }, region: { startLine: 2 } } }] },
        { ruleId: 'javascript/CodeInjection', level: 'error', message: { text: 'Ignored by the team' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js' }, region: { startLine: 1 } } }],
          suppressions: [{ kind: 'external', status: 'accepted' }] },
        { ruleId: 'javascript/CodeInjection', level: 'error', message: { text: 'Ignore proposed, not accepted' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'app.js' }, region: { startLine: 3 } } }],
          suppressions: [{ kind: 'external', status: 'underReview' }] },
      ],
    }
  : {
      tool: { driver: { name: 'Snyk Open Source', rules: [
        { id: 'SNYK-JS-LODASH-567746', shortDescription: { text: 'Prototype Pollution' }, properties: { 'security-severity': '9.8' } },
      ] } },
      results: [
        { ruleId: 'SNYK-JS-LODASH-567746', level: 'error', message: { text: 'lodash@4.17.15 is vulnerable; upgrade to 4.17.21' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'package.json' }, region: { startLine: 1 } } }] },
      ],
    };
writeFileSync(out, JSON.stringify({ version: '2.1.0', runs: [run] }));
process.exit(mode === 'clean' ? 0 : 1);
`;

describe('Snyk engines', { concurrent: false }, () => {
  let cwd: string;
  let bin: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-snyk-'));
    bin = await mkdtemp(path.join(tmpdir(), 'dvalin-fake-snyk-'));
    await writeFile(path.join(cwd, 'app.js'), 'const a = 1;\nconst value = eval(input);\nconst b = 2;\n', 'utf8');
    await writeFile(path.join(cwd, 'package.json'), '{"dependencies":{"lodash":"4.17.15"}}\n', 'utf8');
    await writeFakeScanner(bin, 'snyk', FAKE_SNYK);
    vi.stubEnv('PATH', bin);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  it('never runs unless named, because Snyk Code uploads source', async () => {
    expect(DEFAULT_SCANNER_IDS).not.toContain('snyk-code');
    expect(DEFAULT_SCANNER_IDS).not.toContain('snyk-oss');
    const result = await runDvalinScanSuite(cwd);
    expect(result.scanners.map(run => run.id)).not.toContain('snyk-code');
    const listed = await listDvalinScanners();
    expect(listed.find(scanner => scanner.id === 'snyk-code')).toMatchObject({ available: true, remote: true });
  });

  it('runs snyk code test and reads its SARIF as Snyk Code findings', async () => {
    const result = await runDvalinScanSuite(cwd, { scanners: ['snyk-code'] });
    expect(result.scanners).toEqual([expect.objectContaining({ id: 'snyk-code', status: 'completed', findings: 2 })]);
    const args = await readFile(path.join(cwd, 'snyk-args-code.txt'), 'utf8');
    expect(args.split('\n').slice(0, 2)).toEqual(['code', 'test']);

    const injection = result.findings.find(finding => finding.startLine === 2)!;
    expect(injection).toMatchObject({ scanner: 'snyk-code', source: 'SnykCode', securitySeverity: '8.6' });
    // Attribution survives into the snapshot even for records that lose the stamp.
    expect(scannerIdForSource(injection.source)).toBe('snyk-code');
    expect(snapshotFinding(injection).scanner).toBe('snyk-code');
  });

  it('honors an accepted Snyk ignore, keeps a proposed one, and says how many it set aside', async () => {
    const result = await runDvalinScanSuite(cwd, { scanners: ['snyk-code'] });
    expect(result.findings.map(finding => finding.message)).not.toContain('Ignored by the team');
    expect(result.findings.map(finding => finding.message)).toContain('Ignore proposed, not accepted');
    expect(result.suppressedResults).toBe(1);
    expect(deriveCoverage(result).exclusions).toContain("1 result(s) suppressed by the engines' own ignore policy");
  });

  it('runs snyk test across all projects for dependency findings', async () => {
    const result = await runDvalinScanSuite(cwd, { scanners: ['snyk-oss'] });
    expect(result.scanners).toEqual([expect.objectContaining({ id: 'snyk-oss', status: 'completed', findings: 1 })]);
    const args = await readFile(path.join(cwd, 'snyk-args-test.txt'), 'utf8');
    expect(args).toContain('--all-projects');
    expect(result.findings[0]).toMatchObject({ scanner: 'snyk-oss', ruleId: 'SNYK-JS-LODASH-567746', path: 'package.json' });
    expect(result.metrics.critical).toBe(1);
    expect(scannerIdForSource('Snyk Open Source')).toBe('snyk-oss');
  });

  it('reports a failed login as an error, so the scan is partial rather than clean', async () => {
    vi.stubEnv('FAKE_SNYK_MODE', 'auth');
    const result = await runDvalinScanSuite(cwd, { scanners: ['builtin', 'snyk-code'] });
    expect(result.scanners.find(run => run.id === 'snyk-code')).toMatchObject({ status: 'error' });
    expect(result.scanners.find(run => run.id === 'snyk-code')?.error).toMatch(/snyk auth/);
    expect(deriveCoverage(result).status).toBe('partial');
  });

  it('treats "nothing Snyk supports here" as a completed run with no findings', async () => {
    vi.stubEnv('FAKE_SNYK_MODE', 'unsupported');
    const result = await runDvalinScanSuite(cwd, { scanners: ['snyk-oss'] });
    expect(result.scanners).toEqual([expect.objectContaining({ id: 'snyk-oss', status: 'completed', findings: 0 })]);
  });

  it('is installable and selectable in the policy file', () => {
    expect(dvalinScannerInstallPlan('snyk-code')).toEqual({ scanner: 'snyk-code', supported: true, command: 'npm install -g snyk' });
    const config = parseSecurityConfig({ version: 1, scanners: ['builtin', 'snyk-code', 'snyk-oss'] });
    expect(config.scanners).toEqual(['builtin', 'snyk-code', 'snyk-oss']);
  });
});
