import { describe, expect, it } from 'vitest';
import { nextScannerSelection } from '../web/src/lib/dvalinScanners.ts';
import type { DvalinScanner, DvalinScannerId } from '../web/src/types.ts';

const engine = (id: DvalinScannerId, available: boolean, remote = false): DvalinScanner => ({
  id, name: id, category: 'sast', description: '', available, homepage: '', ...(remote ? { remote } : {}),
});

describe('scanner selection in the Dvalin workspace', () => {
  const installed = [engine('builtin', true), engine('semgrep', true), engine('snyk-code', true, true), engine('snyk-oss', true, true)];

  it('never enables a remote engine on first load, however it got installed', () => {
    const selected = nextScannerSelection(new Set(['builtin']), new Set(), installed);
    expect([...selected].sort()).toEqual(['builtin', 'semgrep']);
  });

  it('does not enable a remote engine that becomes available after an install either', () => {
    const before = new Set<DvalinScannerId>(['builtin', 'semgrep']);
    const selected = nextScannerSelection(before, before, installed);
    expect(selected.has('snyk-code')).toBe(false);
  });

  it('keeps a remote engine the person switched on themselves', () => {
    const before = new Set<DvalinScannerId>(['builtin', 'snyk-code']);
    const selected = nextScannerSelection(before, new Set(['builtin', 'snyk-code']), installed);
    expect(selected.has('snyk-code')).toBe(true);
  });

  it('still enables a newly installed local engine, and drops engines that went missing', () => {
    const selected = nextScannerSelection(new Set(['builtin', 'trivy']), new Set(['builtin', 'trivy']), [engine('builtin', true), engine('trivy', false), engine('semgrep', true)]);
    expect([...selected].sort()).toEqual(['builtin', 'semgrep']);
  });
});
