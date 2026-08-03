import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
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
  /** Use Seatbelt on macOS even when policy permits egress (shell and run_check default). */
  preferSandboxWhenUnrestricted?: boolean;
  /**
   * When org policy permits general egress (network:on), launch without the
   * local subprocess network sandbox. This never widens a restrictive policy:
   * network:off and endpoint-only still require isolation.
   */
  skipNetworkSandboxWhenPolicyAllows?: boolean;
  /** Abort the subprocess when the active agent turn is interrupted. */
  signal?: AbortSignal;
};

export type GovernedExecutableOptions = GovernedProcessOptions;

export async function runGovernedProcess(options: GovernedProcessOptions): Promise<GovernedProcessResult> {
  const egress = checkEgress(options.policy, false);
  const preferSandboxWhenUnrestricted = options.skipNetworkSandboxWhenPolicyAllows
    ? false
    : options.preferSandboxWhenUnrestricted;
  const plan = selectSubprocessSandbox(
    process.platform,
    !egress.allowed,
    detectSubprocessSandboxCapabilities(),
    preferSandboxWhenUnrestricted,
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

  const launch = buildProcessLaunch(options.command, options.args, options.cwd, plan);
  const result = await spawnProcess(
    launch.command,
    launch.args,
    options.cwd,
    options.timeoutMs,
    options.signal,
    launch.windowsVerbatimArguments,
  );
  return { ...result, sandbox: plan.sandbox };
}

/**
 * Run a command + argv pair without a shell. This separate entry point is used
 * by fixed security scanners so request data can never reach `/bin/sh -c`.
 */
export async function runGovernedExecutable(options: GovernedExecutableOptions): Promise<GovernedProcessResult> {
  const egress = checkEgress(options.policy, false);
  const preferSandboxWhenUnrestricted = options.skipNetworkSandboxWhenPolicyAllows
    ? false
    : options.preferSandboxWhenUnrestricted;
  const plan = selectSubprocessSandbox(
    process.platform,
    !egress.allowed,
    detectSubprocessSandboxCapabilities(),
    preferSandboxWhenUnrestricted,
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

  const launch = buildExecutableLaunch(options.command, options.args, options.cwd, plan);
  const result = await spawnExecutableProcess(launch.command, launch.args, options.cwd, options.timeoutMs, options.signal);
  return { ...result, sandbox: plan.sandbox };
}

export type GovernedSession = {
  child: ChildProcess;
  sandbox: SubprocessSandbox;
  /** Terminate the session's whole process tree. Safe to call more than once. */
  kill: () => void;
};

/**
 * Launch a **long-lived** governed subprocess whose stdio stays open for
 * bidirectional messaging — the stdio MCP transport, where `runGovernedProcess`'s
 * run-to-completion contract does not apply.
 *
 * The sandbox decision is identical to the one-shot path: a policy that forbids
 * egress requires real network isolation, and a platform that cannot provide it
 * fails closed rather than launching unrestricted. Callers remain responsible
 * for the command-level policy check before calling this.
 */
export function spawnGovernedSession(
  options: Omit<GovernedProcessOptions, 'timeoutMs'>,
): GovernedSession {
  const egress = checkEgress(options.policy, false);
  const plan = selectSubprocessSandbox(
    process.platform,
    !egress.allowed,
    detectSubprocessSandboxCapabilities(),
    options.skipNetworkSandboxWhenPolicyAllows ? false : options.preferSandboxWhenUnrestricted,
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

  const launch = buildExecutableLaunch(options.command, options.args, options.cwd, plan);
  const usesProcessGroup = process.platform !== 'win32';
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    detached: usesProcessGroup,
    shell: false,
    // stdin and stdout carry the JSON-RPC session; stderr stays separate so
    // server logging can never corrupt the message stream.
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    signalProcessTree(child, 'SIGTERM', usesProcessGroup);
    const force = setTimeout(() => signalProcessTree(child, 'SIGKILL', usesProcessGroup), 1_500);
    force.unref?.();
  };

  options.signal?.addEventListener('abort', kill, { once: true });
  return { child, sandbox: plan.sandbox, kill };
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
    // The sandbox itself is a security boundary. Never select it from a
    // caller-controlled PATH; distributions install bubblewrap at one of these
    // fixed system locations.
    bwrapPath: ['/usr/bin/bwrap', '/bin/bwrap'].find(candidate => existsSync(candidate)),
  };
}

const POSIX_SHELL = '/bin/sh';

export type HostShell = {
  executable: string;
  argsBeforeScript: string[];
  kind: 'cmd' | 'posix';
};

type ProcessLaunch = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/**
 * Resolve the native command interpreter for the host OS.
 *
 * `/bin/sh` is available on Linux and macOS. Windows must use `ComSpec`
 * (normally `C:\Windows\System32\cmd.exe`); falling back to `cmd.exe` lets
 * Windows resolve it from the system search path when ComSpec is absent.
 */
export function resolveHostShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): HostShell {
  if (platform === 'win32') {
    const configured = Object.entries(env)
      .find(([key, value]) => key.toLowerCase() === 'comspec' && value?.trim())?.[1]
      ?.trim();
    return {
      executable: configured || 'cmd.exe',
      // /d disables registry AutoRun hooks, making governed launches deterministic.
      // /s gives /c consistent quote handling for a command supplied as one argv item.
      argsBeforeScript: ['/d', '/s', '/c'],
      kind: 'cmd',
    };
  }
  return { executable: POSIX_SHELL, argsBeforeScript: ['-c'], kind: 'posix' };
}

/**
 * With no `args`, the `command` field is treated as a native shell command line
 * because models routinely put a full line there (`cd X && python …`, pipes,
 * redirection). Linux/macOS route it through `/bin/sh -c`; Windows routes it
 * through `cmd.exe /d /s /c`. With `args`, command is an executable reference
 * and every token is quoted for the host shell.
 *
 * Spawning a full command line directly (`shell: false`) previously made
 * sandbox-exec execvp() the whole line as one path → ENOENT → exit 71.
 */
export function buildShellScript(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  if (args.length === 0) return command;
  const quote = platform === 'win32' ? cmdQuote : posixShellQuote;
  // With explicit args, `command` is an executable name/path rather than a
  // complete shell line. Quote it too so installations under paths such as
  // C:\Program Files\... work correctly.
  return `${quote(command)} ${args.map(quote).join(' ')}`;
}

function posixShellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote one argument in a command line parsed by cmd.exe and then by the
 * launched program's Windows argv parser. Shell metacharacters remain inert
 * inside the quotes, while backslashes before quotes follow the Windows CRT
 * escaping convention.
 */
function cmdQuote(value: string): string {
  if (value === '') return '""';
  if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(value)) return value;

  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes++;
      continue;
    }
    if (char === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes);
    quoted += char;
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  return `${quoted}"`;
}

export function buildProcessLaunch(
  command: string,
  args: string[],
  cwd: string,
  plan: Extract<SubprocessSandboxPlan, { allowed: true }>,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ProcessLaunch {
  const script = buildShellScript(command, args, platform);

  if (plan.sandbox === 'seatbelt') {
    const profile = [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(allow file-read*)',
      `(allow file-write* (subpath "${escapeSeatbeltPath(cwd)}")(subpath "/tmp")(subpath "/var"))`,
    ].join('');
    return { command: plan.executable!, args: ['-p', profile, POSIX_SHELL, '-c', script] };
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
        POSIX_SHELL, '-c', script,
      ],
    };
  }

  const shell = resolveHostShell(platform, env);
  if (shell.kind === 'cmd') {
    // Match Node's own shell:true launch contract. cmd.exe requires the entire
    // /c payload to be surrounded by one verbatim quote pair; letting libuv
    // quote this argv item again can silently drop nested quoted arguments.
    return {
      command: shell.executable,
      args: [...shell.argsBeforeScript, `"${script}"`],
      windowsVerbatimArguments: true,
    };
  }
  return {
    command: shell.executable,
    args: [...shell.argsBeforeScript, script],
  };
}

function buildExecutableLaunch(
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
        '--ro-bind', '/', '/', '--bind', cwd, cwd, '--tmpfs', '/tmp', '--unshare-net',
        '--die-with-parent', '--proc', '/proc', '--dev', '/dev', '--chdir', cwd, '--',
        command, ...args,
      ],
    };
  }
  return { command, args };
}

function spawnExecutableProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Omit<GovernedProcessResult, 'sandbox'>> {
  return spawnProcess(command, args, cwd, timeoutMs, signal);
}

function spawnProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  windowsVerbatimArguments = false,
): Promise<Omit<GovernedProcessResult, 'sandbox'>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('interrupted'));
      return;
    }

    // Governed commands may launch a shell and then further descendants.
    // Give POSIX launches their own process group so abort and timeout signals
    // reach the complete subprocess tree.
    const usesProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      detached: usesProcessGroup,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments,
    });

    let output = '';
    let timedOut = false;
    let interrupted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > 32_000) {
        output = `${output.slice(0, 32_000)}\n[output truncated]`;
      }
    };

    const signalTree = (signal: NodeJS.Signals) => {
      signalProcessTree(child, signal, usesProcessGroup);
    };

    const scheduleForceKill = () => {
      if (killTimer) return;
      killTimer = setTimeout(() => signalTree('SIGKILL'), 1_500);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      signalTree('SIGTERM');
      scheduleForceKill();
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      interrupted = true;
      signalTree('SIGTERM');
      scheduleForceKill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => {
      cleanup();
      if (interrupted) {
        reject(new Error('interrupted'));
        return;
      }
      resolve({ output: error.message, exitCode: 1, timedOut });
    });
    child.on('close', code => {
      cleanup();
      if (interrupted) {
        reject(new Error('interrupted'));
        return;
      }
      resolve({ output: output.trimEnd(), exitCode: code, timedOut });
    });
  });
}

/**
 * POSIX launches get their own process group. Windows has no equivalent signal
 * API in Node, so taskkill /T is required to avoid leaving grandchildren (for
 * example npm -> node) running after an interrupted or timed-out tool call.
 */
function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  usesProcessGroup: boolean,
): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => child.kill());
      return;
    } catch {
      child.kill();
      return;
    }
  }

  if (usesProcessGroup && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child.
    }
  }
  child.kill(signal);
}

function escapeSeatbeltPath(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
