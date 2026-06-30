import { z } from 'zod';
import { runLocalSecurityScan } from '../remediation/localScan.js';
import { upsertRemediationCases } from '../remediation/cases.js';
import type { Tool } from './types.js';

const inputSchema = z.object({
  persistCases: z.boolean().default(true),
}).strict();

type Input = z.infer<typeof inputSchema>;

export const runSecurityScanTool: Tool<Input> = {
  name: 'run_security_scan',
  description: 'Run DvalinCode local security scan on the current workspace and optionally persist findings as remediation cases.',
  access: 'write',
  inputSchema,
  isConcurrencySafe: () => false,
  async run(input, context) {
    const result = await runLocalSecurityScan(context.cwd);
    const cases = input.persistCases && result.findings.length
      ? await upsertRemediationCases({ cwd: context.cwd, findings: result.findings })
      : [];
    return {
      title: 'Security scan',
      output: result.findings.length
        ? result.findings.map((finding, index) => [
            `${index + 1}. ${finding.ruleId} (${finding.securitySeverity ?? finding.severity})`,
            `   ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`,
            `   ${finding.message}`,
          ].join('\n')).join('\n')
        : 'No actionable security findings found.',
      metadata: {
        totalResults: result.totalResults,
        skippedResults: result.skippedResults,
        findings: result.findings,
        cases,
      },
    };
  },
};
