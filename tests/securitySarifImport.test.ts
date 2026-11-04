import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeSecuritySarifImport,
  executeSecurityCodexImport,
  MAX_SECURITY_SARIF_IMPORT_BYTES,
} from '../src/commands/security.js';
import { buildDvalinProgram } from '../src/dvalinCli.js';
import { listRemediationCases } from '../src/remediation/cases.js';

describe('security SARIF handoff', { concurrent: false }, () => {
  let home: string;
  let workspace: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dvalin-sarif-home-'));
    workspace = await mkdtemp(path.join(tmpdir(), 'dvalin-codex-security-'));
    originalHome = process.env.DVALINCODE_HOME;
    process.env.DVALINCODE_HOME = home;
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'app.ts'), 'export const query = input;\n', 'utf8');
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.DVALINCODE_HOME;
    else process.env.DVALINCODE_HOME = originalHome;
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('imports a Codex Security SARIF export as stable remediation cases', async () => {
    const reportPath = path.join(home, 'codex-security.sarif');
    await writeFile(reportPath, JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'Codex Security',
            rules: [{
              id: 'codex-security/authz-bypass',
              name: 'Authorization bypass',
              properties: { tags: ['security', 'authorization'], security_severity: '8.2' },
            }],
          },
        },
        results: [{
          ruleId: 'codex-security/authz-bypass',
          level: 'error',
          message: { text: 'A request can reach this operation without the expected authorization check.' },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: 'src/app.ts' },
              region: { startLine: 1 },
            },
          }],
          partialFingerprints: { primaryLocationLineHash: 'codex-security-finding-1' },
        }],
      }],
    }), 'utf8');

    const imported = await executeSecuritySarifImport({ root: workspace, reportPath });
    const cases = await listRemediationCases({ cwd: imported.root });

    expect(imported).toMatchObject({
      schemaVersion: 1,
      kind: 'dvalin-security-import',
      source: 'Codex Security',
      totalResults: 1,
      skippedResults: 0,
      persisted: true,
    });
    expect(imported.findings).toHaveLength(1);
    expect(imported.findings[0]).toMatchObject({
      source: 'Codex Security',
      ruleId: 'codex-security/authz-bypass',
      path: 'src/app.ts',
      securitySeverity: '8.2',
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ source: 'Codex Security', status: 'open' });
  });

  it('imports and verifies a completed sealed Codex Security scan directory', async () => {
    const scanDirectory = path.join(home, 'codex-scan');
    await writeCodexSecurityScan(scanDirectory, {
      coverage: {
        documentType: 'codex-security.coverage',
        schemaVersion: '1.0',
        scanId: 'scan_test_001',
        mode: 'repository',
        completeness: 'complete',
        inventoryStrategy: 'repository',
        includePaths: ['.'],
        excludePaths: ['vendor/**'],
        surfaces: [{ id: 'auth', label: 'Authorization', disposition: 'reported', receiptRefs: [] }],
        explicitExclusions: [{ pattern: 'vendor/**', reason: 'third-party source' }],
        deferred: [],
        openQuestions: [],
      },
    });

    const imported = await executeSecurityCodexImport({ root: workspace, scanDirectory });
    const cases = await listRemediationCases({ cwd: imported.root });

    expect(imported).toMatchObject({
      schemaVersion: 1,
      kind: 'dvalin-codex-security-import',
      source: 'Codex Security',
      scan: { id: 'scan_test_001', status: 'completed', producer: { name: 'codex-security-plugin', version: '0.1.0' } },
      integrity: { sealed: true },
      coverage: { status: 'complete', includePaths: ['.'], excludePaths: ['vendor/**'] },
      totalResults: 1,
      skippedResults: 0,
      persisted: true,
    });
    expect(imported.integrity.verifiedArtifacts).toHaveLength(2);
    expect(imported.findings[0]).toMatchObject({
      source: 'Codex Security',
      id: 'occ_111111111111111111111111',
      ruleId: 'authorization.missing-check',
      path: 'src/app.ts',
      external: {
        provider: 'codex-security',
        scanId: 'scan_test_001',
        findingId: 'csf_111111111111111111111111',
      },
    });
    expect(cases[0]).toMatchObject({
      source: 'Codex Security',
      external: { scanId: 'scan_test_001', findingId: 'csf_111111111111111111111111' },
    });
  });

  it('preserves Codex Security deferred work and open questions as partial coverage', async () => {
    const scanDirectory = path.join(home, 'partial-codex-scan');
    await writeCodexSecurityScan(scanDirectory, {
      coverage: {
        documentType: 'codex-security.coverage',
        schemaVersion: '1.0',
        scanId: 'scan_test_001',
        mode: 'repository',
        inventoryStrategy: 'repository',
        includePaths: ['.'],
        excludePaths: [],
        surfaces: [{ id: 'crypto', label: 'Cryptography', disposition: 'needs_follow_up', receiptRefs: [] }],
        explicitExclusions: [],
        deferred: [{ id: 'task-1', reason: 'runtime dependency unavailable', paths: ['src/app.ts'] }],
        openQuestions: [{ question: 'Is the upstream caller authenticated?' }],
      },
    });

    const imported = await executeSecurityCodexImport({ root: workspace, scanDirectory, persist: false });

    expect(imported.coverage.status).toBe('partial');
    expect(imported.coverage.deferred).toContain('task-1: runtime dependency unavailable (src/app.ts)');
    expect(imported.coverage.deferred).toContain('Cryptography: needs follow-up');
    expect(imported.coverage.openQuestions).toEqual(['Is the upstream caller authenticated?']);
    expect(imported.cases).toEqual([]);
  });

  it('treats a legacy completed Codex Security manifest without coverage as unknown', async () => {
    const scanDirectory = path.join(home, 'legacy-codex-scan');
    await writeCodexSecurityScan(scanDirectory);

    const imported = await executeSecurityCodexImport({ root: workspace, scanDirectory, persist: false });

    expect(imported.coverage.status).toBe('unknown');
    expect(imported.coverage.notes.join(' ')).toContain('did not include coverage.json');
    expect(imported.integrity.verifiedArtifacts).toHaveLength(1);
  });

  it('rejects incomplete or tampered Codex Security scan directories', async () => {
    const incompleteDirectory = path.join(home, 'incomplete-codex-scan');
    await writeCodexSecurityScan(incompleteDirectory, { status: 'interrupted' });
    await expect(executeSecurityCodexImport({ root: workspace, scanDirectory: incompleteDirectory }))
      .rejects.toThrow('only completed, sealed scans can be imported');

    const tamperedDirectory = path.join(home, 'tampered-codex-scan');
    await writeCodexSecurityScan(tamperedDirectory);
    await writeFile(path.join(tamperedDirectory, 'findings.json'), '{"tampered":true}\n', 'utf8');
    await expect(executeSecurityCodexImport({ root: workspace, scanDirectory: tamperedDirectory }))
      .rejects.toThrow('artifact hash mismatch: findings.json');
  });

  it('can validate a handoff without changing the remediation backlog', async () => {
    const reportPath = path.join(home, 'empty.sarif');
    await writeFile(reportPath, JSON.stringify({ version: '2.1.0', runs: [] }), 'utf8');

    const imported = await executeSecuritySarifImport({ root: workspace, reportPath, persist: false });

    expect(imported.persisted).toBe(false);
    expect(imported.cases).toEqual([]);
    expect(await listRemediationCases({ cwd: workspace })).toEqual([]);
  });

  it('does not persist SARIF findings whose relative path escapes the workspace', async () => {
    const reportPath = path.join(home, 'escape.sarif');
    await writeFile(reportPath, JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'Untrusted Scanner' } },
        results: [{
          ruleId: 'path-escape',
          locations: [{ physicalLocation: { artifactLocation: { uri: '../outside.ts' } } }],
        }],
      }],
    }), 'utf8');

    const imported = await executeSecuritySarifImport({ root: workspace, reportPath });

    expect(imported).toMatchObject({ totalResults: 1, skippedResults: 1, persisted: true });
    expect(imported.findings).toEqual([]);
    expect(imported.cases).toEqual([]);
    expect(await listRemediationCases({ cwd: imported.root })).toEqual([]);
  });

  it('reports malformed JSON and invalid SARIF structure as usage errors', async () => {
    const malformedPath = path.join(home, 'malformed.sarif');
    const invalidPath = path.join(home, 'invalid.sarif');
    await writeFile(malformedPath, '{not-json', 'utf8');
    await writeFile(invalidPath, JSON.stringify({ version: '2.1.0' }), 'utf8');

    await expect(executeSecuritySarifImport({ root: workspace, reportPath: malformedPath }))
      .rejects.toThrow('Invalid SARIF JSON');
    await expect(executeSecuritySarifImport({ root: workspace, reportPath: invalidPath }))
      .rejects.toThrow('expected a top-level runs array');
  });

  it('rejects oversized SARIF before parsing it', async () => {
    const reportPath = path.join(home, 'oversized.sarif');
    await writeFile(reportPath, '', 'utf8');
    await truncate(reportPath, MAX_SECURITY_SARIF_IMPORT_BYTES + 1);

    await expect(executeSecuritySarifImport({ root: workspace, reportPath }))
      .rejects.toThrow('exceeds the 64 MiB import limit');
  });

  it('exposes import directly on the focused dvalin CLI', () => {
    const commands = buildDvalinProgram().commands.map(command => command.name());
    expect(commands).toContain('import');
  });
});

async function writeCodexSecurityScan(
  directory: string,
  options: { status?: string; coverage?: Record<string, unknown> } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const findings = {
    documentType: 'codex-security.findings',
    schemaVersion: '1.0',
    scanId: 'scan_test_001',
    findings: [{
      findingId: 'csf_111111111111111111111111',
      occurrenceId: 'occ_111111111111111111111111',
      ruleId: 'authorization.missing-check',
      identity: { anchor: 'missing-authorization-check' },
      fingerprints: {
        algorithm: 'codex-security/v1',
        primary: `codex-security/v1:sha256:${'1'.repeat(64)}`,
      },
      title: 'Missing authorization check',
      summary: 'An untrusted request can reach the operation without authorization.',
      severity: { level: 'high', score: 8.2, scoringSystem: 'CVSS:3.1' },
      confidence: { level: 'high', rationale: 'The route reaches the operation directly.' },
      taxonomy: { category: 'authorization', cwe: ['CWE-862'] },
      locations: [{ path: 'src/app.ts', startLine: 1, endLine: 1, role: 'sink' }],
      remediation: 'Enforce authorization before invoking the operation.',
      remediationTests: ['Verify an unauthenticated request is rejected.'],
      provenance: { source: 'local_plugin' },
    }],
  };
  const findingsText = `${JSON.stringify(findings, null, 2)}\n`;
  await writeFile(path.join(directory, 'findings.json'), findingsText, 'utf8');

  const artifacts = [{
    path: 'findings.json',
    sha256: sha256(findingsText),
    mediaType: 'application/json',
  }];
  if (options.coverage) {
    const coverageText = `${JSON.stringify(options.coverage, null, 2)}\n`;
    await writeFile(path.join(directory, 'coverage.json'), coverageText, 'utf8');
    artifacts.push({ path: 'coverage.json', sha256: sha256(coverageText), mediaType: 'application/json' });
  }

  const manifest = {
    documentType: 'codex-security.scan-manifest',
    schemaVersion: '1.0',
    scan: {
      id: 'scan_test_001',
      producer: { name: 'codex-security-plugin', version: '0.1.0' },
      status: options.status ?? 'completed',
      startedAt: '2026-11-03T00:00:00Z',
      completedAt: '2026-11-03T00:01:00Z',
      sealedAt: '2026-11-03T00:01:00Z',
      target: {
        kind: 'git_worktree',
        targetId: 'target-test',
        displayName: 'test/repository',
        snapshotDigest: `codex-security-snapshot/v1:sha256:${'2'.repeat(64)}`,
      },
      scope: { includePaths: ['.'], excludePaths: [] },
      mode: 'repository',
      review: { excludedPaths: [] },
      findingsRef: 'findings.json',
      ...(options.coverage ? { coverageRef: 'coverage.json' } : {}),
      artifacts,
    },
  };
  await writeFile(path.join(directory, 'scan-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
