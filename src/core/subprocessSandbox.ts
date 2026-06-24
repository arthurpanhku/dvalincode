import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import type { AuditSink } from '../audit/log.js';
import { checkEgress, PolicyViolationError, type ResolvedPolicy } from './policy.js';

export type SubprocessSandbox = 'seatbelt' | 'bwrap' | 'none';
export type SubprocessSandboxCapabilities = { seatbeltPath?: string; bwrapPath?: string };
export type SubprocessSandboxPlan =
  | { allowed: true; sandbox: SubprocessSandbox; executable?: string }
  | { allowed: false; sandbox: 'none'; reason: string };

export type GovernedProcessResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  sandbox: SubprocessSandbox;
};

export type GovernedProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  policy: ResolvedPolicy;
  audit?: AuditSink;
  toolName: string;
  /** Preserve shell's existing default Seatbelt behavior when network is unrestricted. */
  preferSandboxWhenUnrestricted?: boolean;
};

export async function runGovernedProcess(options: GovernedProcessOptions): Promise<GovernedProcessResult> {
  const egress = checkEgress(options.policy, false);
  const plan = selectSubprocessSandbox(
    process.platform,
    !egress.allowed,
    detectSubprocessSandboxCapabilities(),
    options.preferSandboxWhenUnrestricted,
  );
  if (!plan.allowed) {
    const rule = egress.allowed ? plan.reason : `${egress.rule}; ${plan.reason}`;
    options.audit?.append({
      type: 'policy_violation',
      rule,
      tool: options.toolName,
      target: 'subprocess network isolation',
    });
    throw new PolicyViolationError(options.toolName, rule, 'subprocess network isolation');
  }

  const launch = buildLaunch(options.command, options.args, options.cwd, plan);
  const result = await spawnProcess(launch.command, launch.args, options.cwd, options.timeoutMs);
  return { ...result, sandbox: plan.sandbox };
}

export function selectSubprocessSandbox(
  platform: NodeJS.Platform,
  requiresNetworkIsolation: boolean,
  capabilities: SubprocessSandboxCapabilities,
  preferSandboxWhenUnrestricted = false,
): SubprocessSandboxPlan {
  if (platform === 'darwin') {
    if (capabilities.seatbeltPath && (requiresNetworkIsolation || preferSandboxWhenUnrestricted)) {
      return { allowed: true, sandbox: 'seatbelt', executable: capabilities.seatbeltPath };
    }
    return requiresNetworkIsolation
      ? { allowed: false, sandbox: 'none', reason: 'macOS sandbox-exec is unavailable; restricted subprocess launch fails closed' }
      : { allowed: true, sandbox: 'none' };
  }

  if (platform === 'linux') {
    if (requiresNetworkIsolation && capabilities.bwrapPath) {
      return { allowed: true, sandbox: 'bwrap', executable: capabilities.bwrapPath };
    }
    return requiresNetworkIsolation
      ? { allowed: false, sandbox: 'none', reason: 'Bubblewrap is unavailable; restricted subprocess launch fails closed' }
      : { allowed: true, sandbox: 'none' };
  }

  return requiresNetworkIsolation
    ? { allowed: false, sandbox: 'none', reason: `${platform} has no supported subprocess network sandbox in Governed Network v1` }
    : { allowed: true, sandbox: 'none' };
}

export function detectSubprocessSandboxCapabilities(): SubprocessSandboxCapabilities {
  return {
    seatbeltPath: existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : undefined,
    bwrapPath: findExecutable('bwrap'),
  };
}

function buildLaunch(
  command: string,
  args: string[],
  cwd: string,
  plan: Extract<SubprocessSandboxPlan, { allowed: true }>,
): { command: string; args: string[] } {
  if (plan.sandbox === 'seatbelt') {
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(allow file-read*)',
      `(allow file-write* (subpath "${escapeSeatbeltPath(cwd)}")(subpath "/tmp")(subpath "/var"))`,
    ].join('');
    return { command: plan.executable!, args: ['-p', profile, command, ...args] };
  }

  if (plan.sandbox === 'bwrap') {
    return {
      command: plan.executable!,
      args: [
        '--ro-bind', '/', '/',
        '--bind', cwd, cwd,
        '--tmpfs', '/tmp',
        '--unshare-net',
        '--die-with-parent',
        '--proc', '/proc',
        '--dev', '/dev',
        '--chdir', cwd,
        '--',
        command,
        ...args,
      ],
    };
  }

  return { command, args };
}

function spawnProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<Omit<GovernedProcessResult, 'sandbox'>> {
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

function findExecutable(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

function escapeSeatbeltPath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
