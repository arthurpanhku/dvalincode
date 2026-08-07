import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDvalinSarif } from '../src/remediation/sarifExport.js';
import type { DvalinScanSuiteResult } from '../src/remediation/scannerSuite.js';
import type { RemediationFinding } from '../src/remediation/sarif.js';

const ROOT = path.sep === '\\' ? 'C:\\repo' : '/repo';

function finding(overrides: Partial<RemediationFinding> = {}): RemediationFinding {
  return {
    id: 'LocalScan:dvalin-eval:app.js:3',
    source: 'Dvalin Local Scan',
    ruleId: 'dvalin/eval',
    ruleName: 'Dynamic code execution',
    severity: 'warning',
    securitySeverity: '7.5',
    message: 'Dynamic code execution detected.',
    path: 'app.js',
    startLine: 3,
    endLine: 3,
    helpUri: 'https://cwe.mitre.org/data/definitions/94.html',
    tags: ['security', 'cwe-094'],
    prompt: 'irrelevant to SARIF',
    ...overrides,
  };
}

function suite(findings: RemediationFinding[]): DvalinScanSuiteResult {
  return {
    id: 'scan-1',
    source: 'Dvalin Security Suite',
    startedAt: '2026-08-07T00:00:00.000Z',
    completedAt: '2026-08-07T00:00:01.000Z',
    score: 88,
    grade: 'B',
    findings,
    totalResults: findings.length,
    skippedResults: 0,
    scanners: [],
    metrics: { critical: 0, high: findings.length, medium: 0, low: 0, files: 1, rules: 1 },
  };
}

function firstRun(log: ReturnType<typeof buildDvalinSarif>): any {
  return log.runs[0] as any;
}

describe('buildDvalinSarif', () => {
  it('emits a SARIF 2.1.0 log with one rule per ruleId', () => {
    const log = buildDvalinSarif(suite([finding(), finding({ id: 'second', startLine: 9 })]), ROOT);
    expect(log.version).toBe('2.1.0');
    const run = firstRun(log);
    expect(run.tool.driver.rules).toHaveLength(1);
    expect(run.results).toHaveLength(2);
    expect(run.results[1].ruleIndex).toBe(0);
  });

  it('puts security-severity on the rule so GitHub can band the alert', () => {
    const run = firstRun(buildDvalinSarif(suite([finding()]), ROOT));
    expect(run.tool.driver.rules[0].properties['security-severity']).toBe('7.5');
    expect(run.tool.driver.rules[0].helpUri).toBe('https://cwe.mitre.org/data/definitions/94.html');
  });

  it('emits repository-relative locations with forward slashes', () => {
    const absolute = path.join(ROOT, 'src', 'app.js');
    const run = firstRun(buildDvalinSarif(suite([finding({ path: absolute })]), ROOT));
    expect(run.results[0].locations[0].physicalLocation.artifactLocation.uri).toBe('src/app.js');
  });

  it('anchors findings without a line to line 1 and never inverts the region', () => {
    const run = firstRun(
      buildDvalinSarif(suite([finding({ startLine: undefined, endLine: undefined })]), ROOT),
    );
    const region = run.results[0].locations[0].physicalLocation.region;
    expect(region.startLine).toBe(1);
    expect(region.endLine).toBe(1);
  });

  it('keeps the end line at or after the start line when a scanner reports them reversed', () => {
    const run = firstRun(buildDvalinSarif(suite([finding({ startLine: 12, endLine: 4 })]), ROOT));
    const region = run.results[0].locations[0].physicalLocation.region;
    expect(region.endLine).toBe(region.startLine);
  });

  it('carries a stable fingerprint so unchanged findings do not re-alert', () => {
    const run = firstRun(buildDvalinSarif(suite([finding()]), ROOT));
    expect(run.results[0].partialFingerprints.dvalinFindingId).toBe('LocalScan:dvalin-eval:app.js:3');
  });

  it('omits optional rule fields a scanner did not provide', () => {
    const run = firstRun(
      buildDvalinSarif(suite([finding({ helpUri: undefined, securitySeverity: undefined })]), ROOT),
    );
    expect(run.tool.driver.rules[0]).not.toHaveProperty('helpUri');
    expect(run.tool.driver.rules[0].properties).not.toHaveProperty('security-severity');
  });
});
