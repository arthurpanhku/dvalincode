import type { RemediationFinding } from '../remediation/sarif.js';
import type { DvalinScanSuiteResult } from '../remediation/scannerSuite.js';
import type { SecuritySuppression } from './config.js';
import { findingFingerprint } from './contracts.js';

export type SuppressionResult = {
  result: DvalinScanSuiteResult;
  suppressed: Array<{ finding: RemediationFinding; suppression: SecuritySuppression }>;
  expired: SecuritySuppression[];
};

export function applySecuritySuppressions(
  result: DvalinScanSuiteResult,
  suppressions: SecuritySuppression[],
  now = new Date(),
): SuppressionResult {
  const expired = suppressions.filter(suppression => suppression.expiresAt && Date.parse(suppression.expiresAt) <= now.getTime());
  const active = suppressions.filter(suppression => !expired.includes(suppression));
  const suppressed: SuppressionResult['suppressed'] = [];
  const findings = result.findings.filter(finding => {
    const fingerprint = findingFingerprint(finding);
    const match = active.find(suppression =>
      (suppression.fingerprint === fingerprint || (!suppression.fingerprint && suppression.ruleId === finding.ruleId))
      && (!suppression.path || normalizePath(suppression.path) === normalizePath(finding.path))
    );
    if (!match) return true;
    suppressed.push({ finding, suppression: match });
    return false;
  });
  return {
    result: { ...result, findings, metrics: metricsFor(findings), score: scoreFor(findings), grade: gradeFor(scoreFor(findings)) },
    suppressed,
    expired,
  };
}

function metricsFor(findings: RemediationFinding[]): DvalinScanSuiteResult['metrics'] {
  const metrics: DvalinScanSuiteResult['metrics'] = { critical: 0, high: 0, medium: 0, low: 0, files: 0, rules: 0 };
  const files = new Set<string>();
  const rules = new Set<string>();
  for (const finding of findings) {
    const score = Number.parseFloat(finding.securitySeverity ?? '');
    if (score >= 9) metrics.critical++;
    else if (finding.severity === 'error' || score >= 7) metrics.high++;
    else if (finding.severity === 'warning' || score >= 4) metrics.medium++;
    else metrics.low++;
    files.add(finding.path);
    rules.add(`${finding.source}:${finding.ruleId}`);
  }
  metrics.files = files.size;
  metrics.rules = rules.size;
  return metrics;
}

function scoreFor(findings: RemediationFinding[]): number {
  const metrics = metricsFor(findings);
  return Math.max(0, 100 - metrics.critical * 22 - metrics.high * 12 - metrics.medium * 5 - metrics.low);
}

function gradeFor(score: number): DvalinScanSuiteResult['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
