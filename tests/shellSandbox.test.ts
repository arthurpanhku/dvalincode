import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../src/audit/log.js';
import { PolicyViolationError, resolvePolicy } from '../src/core/policy.js';
import { runGovernedProcess, selectSubprocessSandbox } from '../src/core/subprocessSandbox.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const originalPath = process.env.PATH;

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  vi.clearAllMocks();
});

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

function captureAudit() {
  const events: AuditEvent[] = [];
  return {
    audit: { append: (event: AuditEvent) => events.push(event), getWarnings: () => [] },
    events,
  };
}

describe('shell network sandbox selection', () => {
  it('uses Seatbelt for restricted macOS policies', () => {
    expect(selectSubprocessSandbox('darwin', true, {
      seatbeltPath: '/usr/bin/sandbox-exec',
    })).toEqual({
      allowed: true,
      sandbox: 'seatbelt',
      executable: '/usr/bin/sandbox-exec',
    });
  });

  it('uses Bubblewrap for restricted Linux policies', () => {
    expect(selectSubprocessSandbox('linux', true, { bwrapPath: '/usr/bin/bwrap' })).toEqual({
      allowed: true,
      sandbox: 'bwrap',
      executable: '/usr/bin/bwrap',
    });
  });

  it('fails closed when a restricted platform lacks a sandbox', () => {
    expect(selectSubprocessSandbox('linux', true, {})).toMatchObject({
      allowed: false,
      sandbox: 'none',
    });
    expect(selectSubprocessSandbox('win32', true, {})).toMatchObject({
      allowed: false,
      sandbox: 'none',
    });
  });

  it('preserves unrestricted behavior for network: on', () => {
    expect(selectSubprocessSandbox('linux', false, {})).toEqual({ allowed: true, sandbox: 'none' });
    expect(selectSubprocessSandbox('win32', false, {})).toEqual({ allowed: true, sandbox: 'none' });
  });
});

describe('governed subprocess restricted-network fail-closed integration', () => {
  it.each([
    {
      name: 'Windows with network: off',
      platform: 'win32' as NodeJS.Platform,
      policy: resolvePolicy([{ network: 'off' }]),
      egressRule: 'network egress is disabled by policy (network: off)',
      sandboxReason: 'win32 has no supported subprocess network sandbox in Governed Network v1',
    },
    {
      name: 'Linux without Bubblewrap and endpoint-only network',
      platform: 'linux' as NodeJS.Platform,
      policy: resolvePolicy([{ network: 'endpoint-only' }]),
      egressRule: 'only the configured model endpoint is reachable (network: endpoint-only)',
      sandboxReason: 'Bubblewrap is unavailable; restricted subprocess launch fails closed',
    },
  ])('refuses to spawn and records a policy violation on $name', async ({ platform, policy, egressRule, sandboxReason }) => {
    setPlatform(platform);
    process.env.PATH = '';
    const spawnMock = vi.mocked(spawn);
    const { audit, events } = captureAudit();

    let thrown: unknown;
    try {
      await runGovernedProcess({
        command: process.execPath,
        args: ['-e', 'console.log("should not run")'],
        cwd: process.cwd(),
        timeoutMs: 1_000,
        policy,
        audit: audit as never,
        toolName: 'shell',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PolicyViolationError);
    expect((thrown as PolicyViolationError).rule).toContain(egressRule);
    expect((thrown as PolicyViolationError).rule).toContain(sandboxReason);
    expect((thrown as PolicyViolationError).target).toBe('subprocess network isolation');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'policy_violation',
        rule: expect.stringContaining(sandboxReason),
        tool: 'shell',
        target: 'subprocess network isolation',
      }),
    ]);
  });
});
