import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildShellScript, runGovernedExecutable, runGovernedProcess } from '../src/core/subprocessSandbox.js';
import { resolvePolicy } from '../src/core/policy.js';

describe('buildShellScript', () => {
  it('passes a full command line through unchanged when there are no args', () => {
    expect(buildShellScript('cd repo && python -m pytest', [])).toBe('cd repo && python -m pytest');
    expect(buildShellScript('echo "hello"', [])).toBe('echo "hello"');
    expect(buildShellScript('/bin/echo hello', [])).toBe('/bin/echo hello');
  });

  it('appends args as shell-quoted literals', () => {
    expect(buildShellScript('python', ['-c', "print('hi')"])).toBe(`python -c 'print('\\''hi'\\'')'`);
    expect(buildShellScript('grep', ['-r', 'a b', '.'])).toBe("grep -r 'a b' .");
    expect(buildShellScript('echo', [''])).toBe("echo ''");
  });
});

// Regression for the exit-71 bug: a shell command line placed in `command`
// used to be execvp()'d as a single path under sandbox-exec and fail with
// EX_OSERR. Routing through `/bin/sh -c` must let it run.
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

  it('runs an absolute-path command with an inline argument', async () => {
    const res = await run('/bin/echo hello');
    expect(res.exitCode).toBe(0);
    expect(res.output.trim()).toBe('hello');
  });

  it('runs the split command + args form and quotes args literally', async () => {
    const res = await run('printf', ['%s\n', 'a b']);
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
