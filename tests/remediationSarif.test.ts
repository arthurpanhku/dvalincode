import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSarifForRemediation } from '../src/remediation/sarif.js';

describe('parseSarifForRemediation', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'dvalin-sarif-'));
    await mkdir(path.join(cwd, 'src'));
    await writeFile(
      path.join(cwd, 'src', 'server.ts'),
      [
        'import express from "express";',
        'const app = express();',
        'app.get("/user", (req, res) => {',
        '  const sql = "SELECT * FROM users WHERE name = " + req.query.name;', // scanner fixture
        '  res.send(sql);',
        '});',
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('normalizes SARIF findings and includes workspace source context', async () => {
    const result = await parseSarifForRemediation({
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'CodeQL',
              rules: [
                {
                  id: 'js/sql-injection',
                  name: 'SQL injection',
                  helpUri: 'https://codeql.github.com/',
                  properties: {
                    tags: ['security', 'external/cwe/cwe-089'],
                    security_severity: '8.8',
                  },
                },
              ],
            },
          },
          results: [
            {
              ruleId: 'js/sql-injection',
              level: 'error',
              message: { text: 'This query depends on a user-provided value.' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/server.ts' },
                    region: { startLine: 4 },
                  },
                },
              ],
              partialFingerprints: { primaryLocationLineHash: 'abc123' },
            },
          ],
        },
      ],
    }, { cwd });

    expect(result.totalResults).toBe(1);
    expect(result.skippedResults).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      source: 'CodeQL',
      ruleId: 'js/sql-injection',
      securitySeverity: '8.8',
      path: 'src/server.ts',
      startLine: 4,
    });
    expect(result.findings[0].snippet).toContain('SELECT * FROM users');
    expect(result.findings[0].prompt).toContain('Secure remediation task');
    expect(result.findings[0].prompt).toContain('Run the most relevant tests');
  });

  it('skips SARIF results without a usable source path', async () => {
    const result = await parseSarifForRemediation({
      runs: [
        {
          tool: { driver: { name: 'Semgrep' } },
          results: [
            {
              ruleId: 'generic.secret',
              message: { text: 'No location' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'https://example.com/file.ts' } } }],
            },
          ],
        },
      ],
    });

    expect(result.totalResults).toBe(1);
    expect(result.skippedResults).toBe(1);
    expect(result.findings).toEqual([]);
  });
});
