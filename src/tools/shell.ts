import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DvalinContext } from '../core/context.js';
import { runGovernedProcess } from '../core/subprocessSandbox.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(60_000).default(10_000),
    networkAccess: z
      .enum(['auto', 'sandboxed', 'unrestricted'])
      .default('auto')
      .describe('Use unrestricted only for commands that need outbound network access, such as git pull/push/fetch/clone or package downloads.'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const shellTool: Tool<Input> = {
  name: 'shell',
  description: 'Run a process in the workspace. Use networkAccess=unrestricted for commands that need outbound network access; Git pull/push/fetch/clone can request this automatically.',
  access: 'execute',
  inputSchema,
  isConcurrencySafe: () => false,
  policyTargets: input => [{ kind: 'command', value: [input.command, ...input.args].join(' ') }],
  async run(input, context) {
    const skipNetworkSandbox = await shouldSkipNetworkSandbox(input, context);
    const result = await runGovernedProcess({
      command: input.command,
      args: input.args,
      cwd: context.cwd,
      timeoutMs: input.timeoutMs,
      policy: context.policy,
      audit: context.audit,
      toolName: 'shell',
      preferSandboxWhenUnrestricted: true,
      skipNetworkSandboxWhenPolicyAllows: skipNetworkSandbox,
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
        networkAccess: result.sandbox === 'none' ? 'unrestricted' : 'sandboxed',
        sandboxBypass: skipNetworkSandbox,
        networkEnforcement: result.sandbox === 'none' ? 'unrestricted' : 'enforced',
      },
    };
  },
};

async function shouldSkipNetworkSandbox(input: Input, context: DvalinContext): Promise<boolean> {
  if (input.networkAccess === 'sandboxed') return false;

  if (context.approvalMode === 'bypass') {
    return true;
  }

  const wantsUnrestricted =
    input.networkAccess === 'unrestricted' ||
    (input.networkAccess === 'auto' && isGitNetworkCommand(input.command, input.args));

  if (!wantsUnrestricted) return false;
  if (!context.requestApproval) return false;

  const approved = await context.requestApproval(
    `apv_sandbox_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    'shell_sandbox_bypass',
    {
      command: input.command,
      args: input.args,
      cwd: context.cwd,
      networkAccess: 'unrestricted',
      reason: isGitNetworkCommand(input.command, input.args)
        ? 'Git network operations need outbound access and usually fail inside the local subprocess network sandbox.'
        : 'This command requested unrestricted outbound network access.',
    },
  );
  context.audit?.append({ type: 'approval', toolName: 'shell_sandbox_bypass', approved });
  if (!approved) {
    throw new Error('User rejected unrestricted network access for shell');
  }
  return true;
}

export function isGitNetworkCommand(command: string, args: string[]): boolean {
  if (path.basename(command).toLowerCase() !== 'git') return false;
  const subcommand = findGitSubcommand(args);
  if (!subcommand) return false;

  if (['clone', 'fetch', 'pull', 'push'].includes(subcommand.name)) return true;
  if (subcommand.name === 'remote' && args.slice(subcommand.index + 1).includes('update')) return true;
  if (subcommand.name === 'submodule' && args.slice(subcommand.index + 1).includes('update')) return true;
  if (subcommand.name === 'lfs') {
    return args.slice(subcommand.index + 1).some(arg => ['fetch', 'pull', 'push'].includes(arg));
  }
  return false;
}

function findGitSubcommand(args: string[]): { name: string; index: number } | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg) continue;
    if (arg === '-C' || arg === '-c' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
      i++;
      continue;
    }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=') || arg.startsWith('--namespace=')) {
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { name: arg.toLowerCase(), index: i };
  }
  return null;
}
