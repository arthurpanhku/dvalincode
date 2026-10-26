import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../src/audit/log.js';
import { PolicyViolationError, resolvePolicy } from '../src/core/policy.js';
import { detectSubprocessSandboxCapabilities, runGovernedProcess, selectSubprocessSandbox } from '../src/core/subprocessSandbox.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

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
  vi.mocked(existsSync).mockReset();
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

describe('subprocess sandbox capability detection', () => {
  it.each(['/usr/bin/bwrap', '/bin/bwrap'])('detects Bubblewrap at %s even with an empty PATH', path => {
    process.env.PATH = '';
    vi.mocked(existsSync).mockImplementation(candidate => candidate === path);

    expect(detectSubprocessSandboxCapabilities()).toEqual({
      seatbeltPath: undefined,
      bwrapPath: path,
    });
  });

  it('reports unavailable sandboxes when fixed system paths are absent', () => {
    process.env.PATH = '/untrusted/bin';
    vi.mocked(existsSync).mockReturnValue(false);

    expect(detectSubprocessSandboxCapabilities()).toEqual({
      seatbeltPath: undefined,
      bwrapPath: undefined,
    });
    expect(vi.mocked(existsSync).mock.calls.map(([path]) => path)).toEqual([
      '/usr/bin/sandbox-exec', '/usr/bin/bwrap', '/bin/bwrap',
    ]);
  });
});

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
    // Detection uses fixed system paths, so an empty PATH does not hide a
    // sandbox installed on the CI runner. Model its absence explicitly.
    vi.mocked(existsSync).mockReturnValue(false);
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
