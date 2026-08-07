import path from 'node:path';
import type { DvalinScanSuiteResult } from './scannerSuite.js';
import type { RemediationFinding } from './sarif.js';

/**
 * Emit a scan suite result as SARIF 2.1.0.
 *
 * The target consumer is GitHub code scanning (`upload-sarif`), which renders
 * findings inline on the pull request diff and in the Security tab. That
 * imposes a few constraints beyond the base schema: locations must be
 * repository-relative with forward slashes, `security-severity` must live on
 * the rule as a numeric string, and every result needs a stable fingerprint so
 * the same finding is not re-alerted on each run.
 */

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SARIF_VERSION = '2.1.0';

type SarifLevel = 'error' | 'warning' | 'note' | 'none';

export type DvalinSarifLog = {
  $schema: string;
  version: string;
  runs: unknown[];
};

/** SARIF regions are 1-based; findings without a line anchor to the file head. */
function startLine(finding: RemediationFinding): number {
  const line = finding.startLine ?? 1;
  return line > 0 ? line : 1;
}

function endLine(finding: RemediationFinding): number {
  const start = startLine(finding);
  const end = finding.endLine ?? start;
  return end >= start ? end : start;
}

/** GitHub rejects absolute paths and Windows separators in artifact locations. */
function artifactUri(filePath: string, root: string): string {
  const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
  return relative.split(path.sep).join('/');
}

function toLevel(severity: RemediationFinding['severity']): SarifLevel {
  return severity;
}

export function buildDvalinSarif(result: DvalinScanSuiteResult, root: string): DvalinSarifLog {
  // One rule per ruleId. Findings that share a ruleId are the same rule, even
  // when different scanners reported them.
  const ruleIndex = new Map<string, number>();
  const rules: unknown[] = [];

  const results = result.findings.map(finding => {
    let index = ruleIndex.get(finding.ruleId);
    if (index === undefined) {
      index = rules.length;
      ruleIndex.set(finding.ruleId, index);
      rules.push({
        id: finding.ruleId,
        name: finding.ruleName ?? finding.ruleId,
        shortDescription: { text: finding.ruleName ?? finding.ruleId },
        fullDescription: { text: finding.message },
        ...(finding.helpUri ? { helpUri: finding.helpUri } : {}),
        properties: {
          tags: finding.tags,
          // GitHub maps this number onto its own critical/high/medium/low bands.
          ...(finding.securitySeverity ? { 'security-severity': finding.securitySeverity } : {}),
        },
      });
    }
    return {
      ruleId: finding.ruleId,
      ruleIndex: index,
      level: toLevel(finding.severity),
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: artifactUri(finding.path, root) },
            region: { startLine: startLine(finding), endLine: endLine(finding) },
          },
        },
      ],
      // Keeps an unchanged finding from re-alerting on every scan.
      partialFingerprints: { dvalinFindingId: finding.id },
      properties: { scanner: finding.source },
    };
  });

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [
      {
        tool: {
          driver: {
            name: 'Dvalin',
            informationUri: 'https://github.com/arthurpanhku/dvalincode',
            rules,
          },
        },
        results,
        invocations: [
          {
            executionSuccessful: true,
            startTimeUtc: result.startedAt,
            endTimeUtc: result.completedAt,
          },
        ],
        properties: {
          score: result.score,
          grade: result.grade,
          scanners: result.scanners.map(scanner => ({ id: scanner.id, status: scanner.status })),
        },
      },
    ],
  };
}
