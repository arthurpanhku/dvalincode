import path from 'node:path';
import { findingFingerprint, severityOfFinding, type SecuritySeverity } from '../security/contracts.js';
import type { DvalinScanSuiteResult } from './scannerSuite.js';

/**
 * Emit a scan as a GitLab Code Quality report.
 *
 * GitLab's free tier renders this format in the merge request widget and on
 * the diff, the way GitHub renders SARIF; its own SARIF ingestion needs the
 * Ultimate tier. The fingerprint is the one the baseline uses, so GitLab's
 * "new in this merge request" comparison agrees with Dvalin's.
 *
 * Format: https://docs.gitlab.com/ci/testing/code_quality/#code-quality-report-format
 */

export type CodeQualitySeverity = 'info' | 'minor' | 'major' | 'critical' | 'blocker';

export type CodeQualityIssue = {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: CodeQualitySeverity;
  location: { path: string; lines: { begin: number } };
};

const SEVERITY: Record<SecuritySeverity, CodeQualitySeverity> = {
  critical: 'blocker',
  high: 'critical',
  medium: 'major',
  low: 'minor',
};

export function buildGitlabCodeQuality(result: DvalinScanSuiteResult, root: string): CodeQualityIssue[] {
  return result.findings.map(finding => {
    const relative = path.isAbsolute(finding.path) ? path.relative(root, finding.path) : finding.path;
    return {
      description: `${finding.ruleName ?? finding.ruleId}: ${finding.message}`,
      check_name: finding.ruleId,
      fingerprint: findingFingerprint(finding),
      severity: SEVERITY[severityOfFinding(finding)],
      location: {
        path: relative.split(path.sep).join('/'),
        lines: { begin: finding.startLine && finding.startLine > 0 ? finding.startLine : 1 },
      },
    };
  });
}
