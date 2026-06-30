import { z } from 'zod';
import { getRemediationCase, updateRemediationCase } from '../remediation/cases.js';
import { createRemediationWorktree } from '../remediation/worktree.js';
import type { RemediationFinding } from '../remediation/sarif.js';
import type { Tool } from './types.js';

const inputSchema = z.object({
  caseId: z.string().min(1),
}).strict();

type Input = z.infer<typeof inputSchema>;

export const prepareRemediationWorktreeTool: Tool<Input> = {
  name: 'prepare_remediation_worktree',
  description: 'Create an isolated git worktree for a remediation case and update the case status.',
  access: 'execute',
  inputSchema,
  isConcurrencySafe: () => false,
  async run(input, context) {
    const remediationCase = await getRemediationCase(input.caseId);
    if (!remediationCase) throw new Error(`Remediation case not found: ${input.caseId}`);

    const finding: RemediationFinding = {
      id: remediationCase.findingId,
      source: remediationCase.source,
      ruleId: remediationCase.ruleId,
      severity: remediationCase.severity,
      securitySeverity: remediationCase.securitySeverity,
      message: remediationCase.message,
      path: remediationCase.path,
      startLine: remediationCase.startLine,
      tags: remediationCase.tags,
      prompt: remediationCase.prompt,
    };
    const result = await createRemediationWorktree(context.cwd, finding);
    const updated = await updateRemediationCase(remediationCase.id, {
      status: 'worktree_ready',
      worktreeCwd: result.cwd,
      branch: result.branch,
      prompt: result.prompt,
    });

    return {
      title: 'Remediation worktree',
      output: [
        `Created worktree: ${result.cwd}`,
        `Branch: ${result.branch}`,
        '',
        result.prompt,
      ].join('\n'),
      metadata: { worktree: result, case: updated },
    };
  },
};
