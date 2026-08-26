import { z } from 'zod';
import { runDvalinScanSuite } from '../remediation/scannerSuite.js';
import type { DvalinScanSuiteResult } from '../remediation/scannerSuite.js';
import { upsertRemediationCases } from '../remediation/cases.js';
import { deriveCoverage, type SecurityCoverage } from '../security/contracts.js';
import { renderCoverage } from '../security/render.js';
import type { Tool } from './types.js';

const inputSchema = z.object({
  scanners: z.array(z.enum(['builtin', 'semgrep', 'trivy', 'osv-scanner'])).optional(),
  persistCases: z.boolean().default(true),
}).strict();

type Input = z.infer<typeof inputSchema>;

export function renderSecuritySuiteToolOutput(
  result: DvalinScanSuiteResult,
  coverage: SecurityCoverage = deriveCoverage(result),
): string {
  const scannerSummary = result.scanners
    .map(scanner => `${scanner.name}: ${scanner.status}${scanner.status === 'completed' ? ` (${scanner.findings})` : ''}`)
    .join(' · ');
  return [
    `Security health: ${result.score}/100 (${result.grade})`,
    scannerSummary,
    `Findings: ${result.findings.length} · Critical: ${result.metrics.critical} · High: ${result.metrics.high} · Medium: ${result.metrics.medium}`,
    renderCoverage(coverage),
    ...result.findings.slice(0, 20).map((finding, index) =>
      `${index + 1}. ${finding.ruleId} — ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}\n   ${finding.message}`),
    result.findings.length > 20 ? `… ${result.findings.length - 20} more findings persisted as remediation cases.` : '',
  ].filter(Boolean).join('\n');
}

export const runSecuritySuiteTool: Tool<Input> = {
  name: 'run_security_suite',
  description: 'Run the Dvalin white-box security suite (built-in rules plus installed Semgrep, Trivy, and OSV-Scanner) and persist remediation cases.',
  access: 'execute',
  inputSchema,
  isConcurrencySafe: () => false,
  async run(input, context) {
    const result = await runDvalinScanSuite(context.cwd, { scanners: input.scanners });
    const cases = input.persistCases && result.findings.length
      ? await upsertRemediationCases({ cwd: context.cwd, findings: result.findings })
      : [];
    const coverage = deriveCoverage(result);
    return {
      title: `Dvalin security grade ${result.grade}`,
      output: renderSecuritySuiteToolOutput(result, coverage),
      metadata: { ...result, coverage, cases },
    };
  },
};
