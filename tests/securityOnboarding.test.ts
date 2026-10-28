import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSecurityConfig, writeInitialSecurityConfig } from '../src/security/config.js';
import {
  CI_TEMPLATE_PATHS,
  detectCiProvider,
  detectProjectChecks,
  renderCiTemplate,
  writeCiTemplate,
} from '../src/security/onboarding.js';
import { buildGitlabCodeQuality } from '../src/remediation/codeQualityExport.js';
import { findingFingerprint } from '../src/security/contracts.js';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';

const cleanups: string[] = [];
afterEach(async () => {
  for (const directory of cleanups.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dvalin-onboarding-'));
  cleanups.push(root);
  return root;
}

describe('dvalin init onboarding', () => {
  it('names only the checks the project has, and keeps test as the slot to fill when there are none', async () => {
    const root = await workspace();
    expect(await detectProjectChecks(root)).toEqual(['test']);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', typecheck: 'tsc', lint: 'eslint .' } }));
    expect(await detectProjectChecks(root)).toEqual(['test', 'typecheck', 'lint']);
  });

  it('writes the detected checks and scanners into a policy that still loads', async () => {
    const root = await workspace();
    await writeInitialSecurityConfig(root, false, { scanners: ['builtin', 'semgrep'], checks: ['test', 'lint'] });
    const { config } = await loadSecurityConfig(root);
    expect(config).toMatchObject({ scanners: ['builtin', 'semgrep'], checks: ['test', 'lint'], gate: { severity: 'high', mode: 'new' } });
  });

  it('detects the CI provider from what the repository already contains', async () => {
    const root = await workspace();
    expect(await detectCiProvider(root)).toBeUndefined();
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.example.com:team/app.git\n');
    expect(await detectCiProvider(root)).toBe('gitlab');
    await mkdir(path.join(root, '.github'));
    expect(await detectCiProvider(root)).toBe('github');
    await writeFile(path.join(root, '.gitlab-ci.yml'), 'stages: []\n');
    expect(await detectCiProvider(root)).toBe('gitlab');
  });

  it('pins the action to this release and gates pull requests on what they add', () => {
    const workflow = renderCiTemplate('github', '9.9.9', ['builtin', 'semgrep']);
    expect(workflow).toContain('uses: arthurpanhku/dvalincode@v9.9.9');
    expect(workflow).toContain('scanners: builtin,semgrep');
    expect(workflow).toContain('diff: true');
    expect(workflow).toContain('fetch-depth: 0');
  });

  it('gives GitLab a separate include file with a Code Quality report, never the pipeline itself', async () => {
    expect(CI_TEMPLATE_PATHS.gitlab).not.toBe('.gitlab-ci.yml');
    const job = renderCiTemplate('gitlab', '9.9.9', ['builtin']);
    expect(job).toContain('npx -y dvalincode@9.9.9 security scan .');
    expect(job).toContain('codequality: gl-code-quality-report.json');
  });

  it('leaves an existing CI file alone unless forced', async () => {
    const root = await workspace();
    const target = path.join(root, CI_TEMPLATE_PATHS.github);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'mine\n');
    expect((await writeCiTemplate(root, 'github', '1.0.0', ['builtin'])).written).toBe(false);
    expect(await readFile(target, 'utf8')).toBe('mine\n');
    expect((await writeCiTemplate(root, 'github', '1.0.0', ['builtin'], true)).written).toBe(true);
    expect(await readFile(target, 'utf8')).toContain('dvalincode@v1.0.0');
  });
});

describe('GitLab Code Quality export', () => {
  const finding = {
    id: 'one', source: 'Dvalin Local Scan', ruleId: 'dvalin/eval', ruleName: 'Dynamic code execution', severity: 'error' as const,
    securitySeverity: '9.1', message: 'eval of input', path: '/repo/src/app.ts', startLine: 0, tags: [], prompt: '',
  };
  const result = { findings: [finding] } as unknown as DvalinScanSuiteResult;

  it('maps severity, makes paths repository-relative, and reuses the baseline fingerprint', () => {
    const [issue] = buildGitlabCodeQuality(result, '/repo');
    expect(issue).toEqual({
      description: 'Dynamic code execution: eval of input',
      check_name: 'dvalin/eval',
      fingerprint: findingFingerprint(finding),
      severity: 'blocker',
      location: { path: 'src/app.ts', lines: { begin: 1 } },
    });
  });
});
