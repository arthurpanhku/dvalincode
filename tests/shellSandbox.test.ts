import { describe, expect, it } from 'vitest';
import { selectSubprocessSandbox } from '../src/core/subprocessSandbox.js';

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
