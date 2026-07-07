import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { detectScripts } from './projectScripts.js';
import { checkCommand, PolicyViolationError } from '../core/policy.js';
import { runGovernedProcess } from '../core/subprocessSandbox.js';
import { minimizedDescriptor } from '../audit/minimize.js';
import type { Tool } from './types.js';

const inputSchema = z
  .object({
    kind: z.enum(['test', 'typecheck', 'build', 'lint', 'custom']),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive().max(120_000).default(60_000),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const runCheckTool: Tool<Input> = {
  name: 'run_check',
  description: 'Run a project check such as test, typecheck, build, or lint with structured output. Prefer this over shell for standard validation.',
  access: 'execute',
  inputSchema,
  isConcurrencySafe: () => false,
  isUndoable: () => false,

  async run(input, context) {
    const picked = input.kind === 'custom'
      ? pickCustom(input)
      : await pickProjectCheck(context.cwd, input.kind, input.args);

    if (!picked) {
      return {
        title: 'run_check',
        output: `No ${input.kind} script detected. Use project_scripts to inspect available commands, or run_check kind=custom with an explicit command.`,
        metadata: { kind: input.kind, skipped: true },
      };
    }

    const commandLine = [picked.command, ...picked.args].join(' ');
    const commandDecision = checkCommand(context.policy, commandLine);
    if (!commandDecision.allowed) {
      context.audit?.append({
        type: 'policy_violation',
        rule: commandDecision.rule,
        tool: 'run_check',
        target: minimizedDescriptor(commandLine),
      });
      throw new PolicyViolationError('run_check', commandDecision.rule, commandLine);
    }

    const result = await runGovernedProcess({
      command: picked.command,
      args: picked.args,
      cwd: context.cwd,
      timeoutMs: input.timeoutMs,
      policy: context.policy,
      audit: context.audit,
      toolName: 'run_check',
      preferSandboxWhenUnrestricted: true,
    });
    return {
      title: `run_check ${input.kind}`,
      output: result.output || '(no output)',
      metadata: {
        kind: input.kind,
        command: picked.command,
        args: picked.args,
        argsCount: picked.args.length,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        sandbox: result.sandbox,
        networkEnforcement: result.sandbox === 'none' ? 'unrestricted' : 'enforced',
      },
    };
  },
};

type PickedCommand = { command: string; args: string[] };

function pickCustom(input: Input): PickedCommand | null {
  if (!input.command) return null;
  return { command: input.command, args: input.args };
}

async function pickProjectCheck(cwd: string, kind: Exclude<Input['kind'], 'custom'>, extraArgs: string[]): Promise<PickedCommand | null> {
  const scripts = await detectScripts(cwd);
  const scriptNames = preferredScriptNames(kind);
  const script = scripts.find(s => s.source === 'package.json' && scriptNames.includes(s.name));
  if (script) {
    const pm = await detectPackageManager(cwd);
    return pm === 'yarn'
      ? { command: 'yarn', args: [script.name, ...extraArgs] }
      : { command: pm, args: ['run', script.name, ...extraArgs] };
  }

  if (kind === 'test' && await exists(path.join(cwd, 'pyproject.toml'))) {
    return { command: 'pytest', args: extraArgs };
  }
  if (kind === 'build' && scripts.some(s => s.source === 'Makefile' && s.name === 'build')) {
    return { command: 'make', args: ['build', ...extraArgs] };
  }
  if (kind === 'test' && scripts.some(s => s.source === 'Makefile' && s.name === 'test')) {
    return { command: 'make', args: ['test', ...extraArgs] };
  }
  return null;
}

function preferredScriptNames(kind: Exclude<Input['kind'], 'custom'>): string[] {
  switch (kind) {
    case 'test':
      return ['test', 'test:unit'];
    case 'typecheck':
      return ['typecheck', 'type-check', 'check:types', 'tsc'];
    case 'build':
      return ['build'];
    case 'lint':
      return ['lint'];
  }
}

async function detectPackageManager(cwd: string): Promise<'npm' | 'pnpm' | 'yarn'> {
  if (await exists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
