import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuditSink, newRunId, readRecords } from '../../src/audit/log.js';
import { renderReport, renderRecords } from '../../src/audit/report.js';
import { createDefaultToolRegistry } from '../../src/tools/registry.js';
import { createDvalinContext } from '../../src/core/context.js';
import type { AuditRecord } from '../../src/audit/log.js';
import { resolvePolicy } from '../../src/core/policy.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dvalin-report-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renderReport', () => {
  it('renders task, files changed, commands, and test result', () => {
    const records: AuditRecord[] = [
      { seq: 0, ts: '', prevHash: '', type: 'run_start', task: 'add a feature', mode: 'full-auto', provider: 'deepseek', model: 'x', cwd: '/repo', gitHead: 'abc123' },
      { seq: 1, ts: '', prevHash: '', type: 'file_read', path: 'src/a.ts', sha256: 'h' },
      { seq: 2, ts: '', prevHash: '', type: 'file_write', path: 'src/a.ts', added: 5, removed: 2, beforeHash: 'b', afterHash: 'a' },
      { seq: 3, ts: '', prevHash: '', type: 'shell_exec', command: 'npm test', exitCode: 0, sandbox: 'none' },
      { seq: 4, ts: '', prevHash: '', type: 'run_end', status: 'done', iterations: 3 },
    ];
    const md = renderRecords('run-x', records);

    expect(md).toContain('add a feature');
    expect(md).toContain('`src/a.ts` (+5/−2)');
    expect(md).toContain('`npm test` → exit 0');
    expect(md).toContain('✅ passed');
    expect(md).toContain('Status: **done**');
  });

  it('reads the JSONL from disk', () => {
    const runId = newRunId();
    const sink = new AuditSink(runId, dir);
    sink.append({ type: 'run_start', task: 'hello', mode: 'readonly', provider: 'p', model: 'm', cwd: '/x', gitHead: null });
    sink.append({ type: 'run_end', status: 'done', iterations: 1 });

    const md = renderReport(runId, dir);
    expect(md).toContain('hello');
    expect(md).toContain('_(not a git repo)_');
  });
});

describe('registry → audit integration', () => {
  it('records a file_write whose +/- stat matches the edit', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'dvalin-ws-'));
    const runId = newRunId();
    const sink = new AuditSink(runId, dir);
    const registry = createDefaultToolRegistry();
    const context = createDvalinContext({ cwd: workspace, allowWrite: true, audit: sink });

    // Create a 2-line file, then append a line via write_file (1 added).
    await registry.run('write_file', { filePath: 'f.txt', content: 'a\nb' }, context);
    await registry.run('write_file', { filePath: 'f.txt', content: 'a\nb\nc' }, context);

    const records = readRecords(runId, dir);
    const writes = records.filter(r => r.type === 'file_write') as Extract<AuditRecord, { type: 'file_write' }>[];
    expect(writes).toHaveLength(2);
    // Second write added exactly one line.
    expect(writes[1].added).toBe(1);
    expect(writes[1].removed).toBe(0);
    expect(writes[1].beforeHash).not.toBeNull();

    // The Run Report lists the changed file.
    expect(renderReport(runId, dir)).toContain('`f.txt`');
    expect(JSON.stringify(records)).not.toContain('"content":"a\\nb\\nc"');

    rmSync(workspace, { recursive: true, force: true });
  });

  it('still records tool_call when a tool throws', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'dvalin-ws-'));
    const runId = newRunId();
    const sink = new AuditSink(runId, dir);
    const registry = createDefaultToolRegistry();
    const context = createDvalinContext({ cwd: workspace, allowWrite: true, audit: sink });

    await expect(
      registry.run('edit_file', { filePath: 'missing.txt', oldString: 'x', newString: 'y' }, context),
    ).rejects.toThrow();

    const calls = readRecords(runId, dir).filter(r => r.type === 'tool_call') as Extract<AuditRecord, { type: 'tool_call' }>[];
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe('error');
    expect(calls[0].argsSummary).not.toContain('"oldString":"x"');
    expect(calls[0].argsSummary).not.toContain('"newString":"y"');

    rmSync(workspace, { recursive: true, force: true });
  });

  it('minimizes denied command targets before audit persistence', async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'dvalin-ws-'));
    const runId = newRunId();
    const sink = new AuditSink(runId, dir);
    const registry = createDefaultToolRegistry();
    const context = createDvalinContext({
      cwd: workspace,
      approvalMode: 'full-auto',
      audit: sink,
      policy: resolvePolicy([{ commands: { deny: ['blocked-command'] } }]),
    });

    await expect(registry.run('shell', {
      command: 'blocked-command',
      args: ['secret-argument'],
    }, context)).rejects.toThrow('command matches denylist');

    const serialized = JSON.stringify(readRecords(runId, dir));
    expect(serialized).toContain('minimized sha256:');
    expect(serialized).not.toContain('secret-argument');
    rmSync(workspace, { recursive: true, force: true });
  });
});
