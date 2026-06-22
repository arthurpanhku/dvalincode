import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Tool } from './types.js';

const execAsync = promisify(execFile);

async function isSandboxExecAvailable(): Promise<boolean> {
  try { await execAsync('which', ['sandbox-exec']); return true; } catch { return false; }
}

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
    const sandboxEnabled = process.platform === 'darwin' && await isSandboxExecAvailable();
    const result = await runProcess(input.command, input.args, context.cwd, input.timeoutMs, sandboxEnabled);
    return {
      title: `Ran ${input.command}`,
      output: result.output || '(no output)',
      metadata: {
        command: input.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        sandbox: sandboxEnabled ? 'seatbelt' : 'none',
      },
    };
  },
};

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  sandboxEnabled: boolean,
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  // On macOS, wrap in sandbox-exec to deny network access while allowing file operations
  let spawnCommand: string;
  let spawnArgs: string[];

  if (sandboxEnabled) {
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(allow file-read*)',
      `(allow file-write* (subpath "${cwd}")(subpath "/tmp")(subpath "/var"))`,
    ].join('');
    spawnCommand = 'sandbox-exec';
    spawnArgs = ['-p', profile, command, ...args];
  } else {
    spawnCommand = command;
    spawnArgs = args;
  }

  return new Promise(resolve => {
    const child = spawn(spawnCommand, spawnArgs, {
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
