import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildProcessLaunch,
  buildShellScript,
  resolveHostShell,
  runGovernedExecutable,
  runGovernedProcess,
} from '../src/core/subprocessSandbox.js';
import { resolvePolicy } from '../src/core/policy.js';

describe('buildShellScript', () => {
  it('passes a full command line through unchanged when there are no args', () => {
    expect(buildShellScript('cd repo && python -m pytest', [], 'linux')).toBe('cd repo && python -m pytest');
    expect(buildShellScript('echo "hello"', [], 'darwin')).toBe('echo "hello"');
  });

  it('appends args as shell-quoted literals', () => {
    expect(buildShellScript('python', ['-c', "print('hi')"], 'linux')).toBe(`python -c 'print('\\''hi'\\'')'`);
    expect(buildShellScript('grep', ['-r', 'a b', '.'], 'darwin')).toBe("grep -r 'a b' .");
    expect(buildShellScript('echo', [''], 'linux')).toBe("echo ''");
  });

  it('uses Windows command-line quoting for cmd.exe', () => {
    expect(buildShellScript('node', ['script.js', 'a b', 'a&b', ''], 'win32'))
      .toBe('node script.js "a b" "a&b" ""');
    expect(buildShellScript('C:\\Program Files\\nodejs\\node.exe', ['--version'], 'win32'))
      .toBe('"C:\\Program Files\\nodejs\\node.exe" --version');
    expect(buildShellScript('echo hello & ver', [], 'win32')).toBe('echo hello & ver');
  });
});

describe('native host shell selection', () => {
  it.each(['linux', 'darwin'] as const)('uses /bin/sh on %s', platform => {
    expect(resolveHostShell(platform)).toEqual({
      executable: '/bin/sh',
      argsBeforeScript: ['-c'],
      kind: 'posix',
    });
  });

  it('uses ComSpec and disables AutoRun hooks on Windows', () => {
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    expect(resolveHostShell('win32', env)).toEqual({
      executable: env.ComSpec,
      argsBeforeScript: ['/d', '/s', '/c'],
      kind: 'cmd',
    });
  });

  it('falls back to cmd.exe when Windows ComSpec is unavailable', () => {
    expect(resolveHostShell('win32', {})).toMatchObject({ executable: 'cmd.exe', kind: 'cmd' });
  });

  it('builds a Windows launch without referencing /bin/sh', () => {
    expect(buildProcessLaunch(
      'echo hello & ver',
      [],
      'C:\\workspace',
      { allowed: true, sandbox: 'none' },
      'win32',
      { COMSPEC: 'C:\\Windows\\System32\\cmd.exe' },
    )).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'echo hello & ver'],
    });
  });

  it.each(['linux', 'darwin'] as const)('builds a POSIX launch on %s', platform => {
    expect(buildProcessLaunch(
      'printf',
      ['%s', 'hello world'],
      '/workspace',
      { allowed: true, sandbox: 'none' },
      platform,
      {},
    )).toEqual({
      command: '/bin/sh',
      args: ['-c', "printf %s 'hello world'"],
    });
  });
});

// Regression for the exit-71 bug: a shell command line placed in `command`
// used to be execvp()'d as a single path under sandbox-exec and fail with
// EX_OSERR. Routing through the native host shell must let it run.
describe('runGovernedProcess (real subprocess)', () => {
  let cwd: string;
  const policy = resolvePolicy([]);

  beforeAll(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'dvalin-shell-'));
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const run = (command: string, args: string[] = []) =>
    runGovernedProcess({
      command,
      args,
      cwd,
      timeoutMs: 10_000,
      policy,
      toolName: 'shell',
      preferSandboxWhenUnrestricted: true,
    });

  it('runs a command line with shell operators from the command field', async () => {
    const res = await run('echo hello && echo world');
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain('hello');
    expect(res.output).toContain('world');
  });

  it.skipIf(process.platform === 'win32')('runs an absolute-path command with an inline argument', async () => {
    const res = await run('/bin/echo hello');
    expect(res.exitCode).toBe(0);
    expect(res.output.trim()).toBe('hello');
  });

  it('runs the split command + args form and quotes args literally', async () => {
    const res = await run(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', 'a b'],
    );
    expect(res.exitCode).toBe(0);
    expect(res.output.trim()).toBe('a b');
  });
});

describe('runGovernedExecutable', () => {
  it('passes arguments literally without shell interpretation', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'dvalin-executable-'));
    try {
      const res = await runGovernedExecutable({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', 'value; echo injected'],
        cwd,
        timeoutMs: 10_000,
        policy: resolvePolicy([]),
        toolName: 'run_security_suite',
      });
      expect(res.exitCode).toBe(0);
      expect(res.output).toBe('value; echo injected');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
