import type { DvalinScanSuiteResult } from './scannerSuite.js';
import type { RemediationFinding } from './sarif.js';
import { readRecords } from '../audit/log.js';
import type { SecurityCheckEvidence } from '../security/workflow.js';

export const VERIFICATION_MARKER = 'DVALIN_VERIFICATION_PASSED';

function findingKey(finding: RemediationFinding): string {
  return `${finding.source}\0${finding.ruleId}\0${finding.path}`;
}

function severityWeight(finding: RemediationFinding): number {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (Number.isFinite(score)) return score;
  return finding.severity === 'error' ? 8 : finding.severity === 'warning' ? 5 : 1;
}

export function buildAutomatedFixPrompt(findings: RemediationFinding[], worktreeContext?: string): string {
  return [
    'Perform an automated Dvalin remediation for the scanner findings below.',
    worktreeContext ?? '',
    '',
    ...findings.map((finding, index) => [
      `${index + 1}. ${finding.source} / ${finding.ruleId}`,
      `   ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`,
      `   ${finding.message}`,
    ].join('\n')),
    '',
    'Required workflow:',
    '1. Reproduce or validate every finding against reachable source and data flow before editing. Treat scanner output as a hypothesis and explicitly reject false positives.',
    '2. Fix confirmed vulnerabilities with the smallest behavior-preserving change. Never weaken tests, add scanner suppressions, or edit generated/vendor code to hide a result.',
    '3. Add or update focused regression tests only when they demonstrate the vulnerable behavior without embedding live credentials.',
    '4. Run focused checks for changed code and inspect git diff for unrelated edits.',
    '5. Do not commit, push, publish a pull request, or merge in this phase.',
    'Return a concise summary of confirmed fixes, rejected findings, changed files, and checks run.',
  ].filter(Boolean).join('\n');
}

export function buildAutomatedVerificationPrompt(findings: RemediationFinding[], scanners: string[]): string {
  return [
    'Verify the Dvalin remediation. Do not make further code changes unless a focused test cannot run because of a trivial fix introduced in this same remediation.',
    '',
    `Original findings: ${findings.map(finding => `${finding.ruleId} at ${finding.path}`).join('; ')}`,
    `Scanner set: ${scanners.join(', ')}`,
    '',
    'Hard verification requirements:',
    '1. Inspect git status and the complete diff. Fail on unrelated changes, test weakening, scanner suppression, generated artifacts, or secrets.',
    '2. Use the run_check tool for focused tests covering every changed area. Then use run_check for the project typecheck/build/test command that is proportionate to the change.',
    '3. Run the Dvalin security suite again and confirm the original finding class is gone without introducing a new high/critical finding.',
    '4. If any required command fails, evidence is missing, or a finding remains, explain the failure and end with DVALIN_VERIFICATION_FAILED.',
    `5. Only when every requirement passes, end the response with the exact standalone line ${VERIFICATION_MARKER}.`,
  ].join('\n');
}

export function buildDraftPrPrompt(findings: RemediationFinding[]): string {
  return [
    'The independent Dvalin verification gate passed. Publish this isolated remediation branch as a draft pull request.',
    '',
    `Remediated findings: ${findings.map(finding => `${finding.ruleId} (${finding.path})`).join('; ')}`,
    '',
    'Re-check git status and diff, commit only the remediation changes, push the current branch, and create a draft PR with gh.',
    'The PR body must include vulnerability impact, source validation, changed files, tests and scanner evidence, and remaining risk.',
    'Do not merge the PR and do not mark it ready for review. Return the draft PR URL.',
  ].join('\n');
}

export type VerificationGate = { passed: boolean; reasons: string[] };

/** Extract process exit codes from the tamper-evident audit trail, not model prose. */
export function verificationEvidenceFromAudit(runId: string, auditDir?: string): SecurityCheckEvidence[] {
  const records = readRecords(runId, auditDir);
  const evidence: SecurityCheckEvidence[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    if (record.type !== 'tool_call' || record.tool !== 'run_check') continue;
    const execution = records.slice(index + 1).find(candidate => candidate.type === 'tool_call' || candidate.type === 'shell_exec');
    if (!execution || execution.type !== 'shell_exec') continue;
    evidence.push({
      kind: record.argsSummary,
      command: execution.command,
      exitCode: execution.exitCode,
      passed: record.status === 'ok' && execution.exitCode === 0,
    });
  }
  return evidence;
}

export function evaluateVerificationGate(input: {
  originals: RemediationFinding[];
  baseline?: RemediationFinding[];
  after: DvalinScanSuiteResult;
  agentOutput: string;
  hasChanges: boolean;
  checkEvidence?: SecurityCheckEvidence[];
}): VerificationGate {
  const reasons: string[] = [];
  const originalKeys = new Set(input.originals.map(findingKey));
  const baselineKeys = new Set((input.baseline ?? input.originals).map(findingKey));
  const afterKeys = new Set(input.after.findings.map(findingKey));
  const remaining = [...originalKeys].filter(key => afterKeys.has(key));
  if (remaining.length) reasons.push(`${remaining.length} original finding target(s) remain after re-scan`);

  const newSevere = input.after.findings.filter(finding => severityWeight(finding) >= 7 && !baselineKeys.has(findingKey(finding)));
  if (newSevere.length) reasons.push(`${newSevere.length} new high/critical finding target(s) appeared`);
  if (!input.hasChanges) reasons.push('the remediation worktree has no code changes');

  if (input.checkEvidence) {
    if (!input.checkEvidence.length) reasons.push('no run_check execution evidence was recorded');
    const failedChecks = input.checkEvidence.filter(check => !check.passed);
    if (failedChecks.length) reasons.push(`${failedChecks.length} recorded check(s) failed`);
  } else {
    // Compatibility for programmatic callers that have not supplied audit
    // evidence. The automated remediation path always supplies it.
    const markerPattern = new RegExp(`(?:^|\\n)${VERIFICATION_MARKER}(?:\\n|$)`);
    if (!markerPattern.test(input.agentOutput.trim())) reasons.push('focused tests/build were not reported as passing');
  }
  return { passed: reasons.length === 0, reasons };
}

export function extractDraftPrUrl(output: string): string | undefined {
  return output.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/)?.[0];
}
