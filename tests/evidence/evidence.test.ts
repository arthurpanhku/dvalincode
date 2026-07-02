import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditSink } from '../../src/audit/log.js';
import { buildEvidencePack, verifyEvidencePack, type EvidencePack } from '../../src/evidence/pack.js';

function seedRun(dir: string, runId: string): void {
  const sink = new AuditSink(runId, dir);
  sink.append({
    type: 'run_start',
    task: 'minimized sha256:abc bytes:12',
    mode: 'code',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    cwd: '/repo',
    gitHead: 'a1b2c3',
    sessionId: 'dc_sess_1',
  });
  sink.append({ type: 'tool_call', tool: 'read_file', argsSummary: '{"sha256":"x"}', status: 'ok', durationMs: 2 });
  sink.append({ type: 'run_end', status: 'done', iterations: 1 });
}

function build(auditDir: string): EvidencePack {
  return buildEvidencePack({ auditDir, sessionsDir: join(auditDir, 'sessions'), last: 10 });
}

describe('Evidence Pack', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-evidence-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('builds a valid pack with no runs (policy + trust + manifest still present)', () => {
    const pack = build(dir);
    expect(pack.schema).toBe('dvalincode-evidence/v1');
    expect(pack.runs).toEqual([]);
    expect(pack.policy.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(pack.trust.version).toBeTruthy();
    expect(pack.manifest.bundleHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyEvidencePack(pack).ok).toBe(true);
  });

  it('embeds and verifies audit run chains', () => {
    seedRun(dir, 'run-A');
    seedRun(dir, 'run-B');
    const pack = build(dir);
    expect(pack.runs.map(r => r.runId).sort()).toEqual(['run-A', 'run-B']);
    expect(pack.runs.every(r => r.verify.ok)).toBe(true);
    expect(pack.runs[0].meta?.provider).toBe('deepseek');

    const report = verifyEvidencePack(pack);
    expect(report.ok).toBe(true);
    expect(report.runIssues).toEqual([]);
  });

  it('detects a tampered section via hash mismatch', () => {
    seedRun(dir, 'run-A');
    const pack = build(dir);
    // Forge the recorded policy hash without recomputing the manifest.
    const tampered = structuredClone(pack);
    tampered.policy.hash = 'f'.repeat(64);

    const report = verifyEvidencePack(tampered);
    expect(report.ok).toBe(false);
    expect(report.sectionIssues.some(i => i.includes('policy'))).toBe(true);
    expect(report.bundleHashOk).toBe(false);
  });

  it('detects a record edited inside an embedded run', () => {
    seedRun(dir, 'run-A');
    const pack = build(dir);
    const tampered = structuredClone(pack);
    // Change a field inside the chain without fixing prevHash links.
    (tampered.runs[0].records[1] as { tool: string }).tool = 'shell';

    const report = verifyEvidencePack(tampered);
    expect(report.ok).toBe(false);
    expect(report.runIssues.some(i => i.includes('run-A'))).toBe(true);
  });

  it('contains no credential-shaped fields and flags injected secrets', () => {
    seedRun(dir, 'run-A');
    const pack = build(dir);
    // A clean pack passes the minimization scan.
    expect(verifyEvidencePack(pack).minimizationIssues).toEqual([]);

    // Inject a secret to prove the scanner catches leakage.
    const leaked = structuredClone(pack) as EvidencePack & { policy: { apiKey?: string } };
    leaked.policy.apiKey = 'sk-live-should-never-be-here';
    expect(verifyEvidencePack(leaked).minimizationIssues.length).toBeGreaterThan(0);
  });

  it('marks run-backed compliance controls unbacked when there are no runs', () => {
    const empty = build(dir);
    const runsControl = empty.compliance.find(c => c.section === 'runs');
    expect(runsControl?.backed).toBe(false);
    const policyControl = empty.compliance.find(c => c.section === 'policy');
    expect(policyControl?.backed).toBe(true);

    seedRun(dir, 'run-A');
    const withRun = build(dir);
    expect(withRun.compliance.find(c => c.section === 'runs')?.backed).toBe(true);
  });
});
