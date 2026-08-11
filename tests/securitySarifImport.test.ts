import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  executeSecuritySarifImport,
  MAX_SECURITY_SARIF_IMPORT_BYTES,
} from '../src/commands/security.js';
import { buildDvalinProgram } from '../src/dvalinCli.js';
import { listRemediationCases } from '../src/remediation/cases.js';

describe.sequential('security SARIF handoff', () => {
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
