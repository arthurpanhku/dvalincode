/**
 * Checks the extension against the real CLI, not a fixture — the JSON contract
 * between them is the one thing unit tests cannot prove.
 *
 * Skipped unless DVALIN_E2E=1, because it downloads the published package and
 * needs network. Run it when the CLI's `--json` shape changes:
 *
 *   DVALIN_E2E=1 npm test
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupByPath, Severity, summarize } from '../src/findings.js';
import { runScan } from '../src/scan.js';

const enabled = process.env.DVALIN_E2E === '1';

describe.skipIf(!enabled)('against the published CLI', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'dvalin-vscode-e2e-'));
    writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
    execFileSync('git', ['init'], { cwd });
    execFileSync('git', ['config', 'user.email', 'dvalin-e2e@example.invalid'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Dvalin E2E'], { cwd });
    execFileSync('git', ['add', 'package.json'], { cwd });
    execFileSync('git', ['commit', '-m', 'fixture baseline'], { cwd });
    writeFileSync(
      path.join(cwd, 'vuln.js'),
      'const express = require("express");\nconst app = express();\napp.post("/calc", (req, res) => { res.send(String(eval(req.body.expr))); });\n',
    );
  });

  afterAll(() => rmSync(cwd, { recursive: true, force: true }));

  it('parses a real scan and maps it onto editor findings', async () => {
    const outcome = await runScan({ command: 'npx -y dvalincode', cwd, scanners: 'builtin', timeoutMs: 180_000, scope: 'changed' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const grouped = groupByPath(outcome.result);
    const findings = grouped.get('vuln.js');
    expect(findings, 'the eval fixture should produce a finding').toBeTruthy();

    const evalFinding = findings!.find(f => f.ruleId.includes('eval'));
    expect(evalFinding).toBeTruthy();
    // The fixture puts `eval` on source line 3, which is editor line 2.
    expect(evalFinding!.range.startLine).toBe(2);
    expect(evalFinding!.severity).toBe(Severity.Error);
    expect(evalFinding!.helpUri).toContain('cwe.mitre.org');
    expect(summarize(outcome.result)).toContain('finding');
    expect(['complete', 'partial', 'unknown']).toContain(outcome.result.coverage?.status);
    expect(outcome.result.coverage?.deferred.join(' ')).toContain('scoped to HEAD');
  }, 200_000);
});
