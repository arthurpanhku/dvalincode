import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildTrustReport, renderTrustReport } from '../../src/core/trust.js';

describe('trust report', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    delete process.env.DVALINCODE_POLICY_FILE;
    while (cleanups.length) cleanups.pop()!();
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-trust-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('reports permissive when no policy file is in effect', () => {
    process.env.DVALINCODE_POLICY_FILE = path.join(tempDir(), 'absent.json');
    const report = buildTrustReport(tempDir());
    expect(report.policy.constrained).toBe(false);
    expect(report.version).toBeTruthy();
    expect(report.runtime.platform).toBe(process.platform);

    const text = renderTrustReport(report);
    expect(text).toContain('permissive');
    expect(text).toContain('可控');
    expect(text).toContain('可审计');
  });

  it('reports constrained and surfaces the active policy', () => {
    process.env.DVALINCODE_POLICY_FILE = path.join(tempDir(), 'absent.json');
    const repoDir = tempDir();
    writeFileSync(
      path.join(repoDir, 'dvalin.policy.json'),
      JSON.stringify({ modes: ['chat'], network: 'endpoint-only', tools: { deny: ['shell'] } }),
    );

    const report = buildTrustReport(repoDir);
    expect(report.policy.constrained).toBe(true);
    expect(report.policy.resolved.network).toBe('endpoint-only');
    expect(report.policy.hash).toMatch(/^[a-f0-9]{64}$/);

    const text = renderTrustReport(report);
    expect(text).toContain('constrained');
    expect(text).toContain('endpoint-only');
    expect(text).toContain('deny: shell');
  });

  it('flags an ignored malformed policy in the rendered report', () => {
    process.env.DVALINCODE_POLICY_FILE = path.join(tempDir(), 'absent.json');
    const repoDir = tempDir();
    writeFileSync(path.join(repoDir, 'dvalin.policy.json'), '{ broken');

    const text = renderTrustReport(buildTrustReport(repoDir));
    expect(text).toContain('IGNORED');
  });
});
