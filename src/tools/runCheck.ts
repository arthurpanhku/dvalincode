import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { detectScripts } from './projectScripts.js';
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

    const result = await runProcess(picked.command, picked.args, context.cwd, input.timeoutMs);
    return {
      title: `run_check ${input.kind}`,
      output: result.output || '(no output)',
      metadata: {
        kind: input.kind,
        command: picked.command,
        args: picked.args,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
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

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 32_000) {
        output = `${output.slice(0, 32_000)}\n[output truncated]`;
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ output: error.message, exitCode: 1, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ output: output.trimEnd(), exitCode: code, timedOut });
    });
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
