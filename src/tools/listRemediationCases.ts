import { z } from 'zod';
import { listRemediationCases } from '../remediation/cases.js';
import type { Tool } from './types.js';

const inputSchema = z.object({
  limit: z.number().int().positive().max(100).default(20),
}).strict();

type Input = z.infer<typeof inputSchema>;

export const listRemediationCasesTool: Tool<Input> = {
  name: 'list_remediation_cases',
  description: 'List local remediation cases for the current workspace.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  async run(input, context) {
    const cases = await listRemediationCases({ cwd: context.cwd, limit: input.limit });
    return {
      title: 'Remediation cases',
      output: cases.length
        ? cases.map(item => `- ${item.id} [${item.status}] ${item.ruleId} ${item.path}${item.startLine ? `:${item.startLine}` : ''}`).join('\n')
        : 'No remediation cases found for this workspace.',
      metadata: { cases },
    };
  },
};
