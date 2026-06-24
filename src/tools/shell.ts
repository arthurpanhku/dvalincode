import { z } from 'zod';
import { runGovernedProcess } from '../core/subprocessSandbox.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const shellTool: Tool<Input> = {
  name: 'shell',
  description: 'Run a process in the workspace. Requires explicit execution permission.',
  access: 'execute',
  inputSchema,
  isConcurrencySafe: () => false,
  policyTargets: input => [{ kind: 'command', value: [input.command, ...input.args].join(' ') }],
  async run(input, context) {
    const result = await runGovernedProcess({
      command: input.command,
      args: input.args,
      cwd: context.cwd,
      timeoutMs: input.timeoutMs,
      policy: context.policy,
      audit: context.audit,
      toolName: 'shell',
      preferSandboxWhenUnrestricted: true,
    });
    return {
      title: `Ran ${input.command}`,
      output: result.output || '(no output)',
      metadata: {
        command: input.command,
        argsCount: input.args.length,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        sandbox: result.sandbox,
        networkEnforcement: result.sandbox === 'none' ? 'unrestricted' : 'enforced',
      },
    };
  },
};
