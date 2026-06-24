import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDvalinContext } from '../src/core/context.js';
import { createDefaultToolRegistry } from '../src/tools/registry.js';
import { projectScriptsTool } from '../src/tools/projectScripts.js';
import { runCheckTool } from '../src/tools/runCheck.js';
import { resolvePolicy } from '../src/core/policy.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dvalincode-tools-extra-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('extra tools', () => {
  it('registers memory and diagnostic tools by default', () => {
    const registry = createDefaultToolRegistry();
    const names = registry.list().map(tool => tool.name);
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_write');
    expect(names).toContain('memory_import');
    expect(names).toContain('git_diff');
    expect(names).toContain('project_scripts');
    expect(names).toContain('run_check');
  });

  it('detects package.json scripts', async () => {
    writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
    }, null, 2));

    const result = await projectScriptsTool.run({}, createDvalinContext({ cwd: tmpDir }));
    expect(result.output).toContain('package.json:test');
    expect(result.output).toContain('package.json:typecheck');
  });

  it('runs a custom check with structured metadata', async () => {
    const result = await runCheckTool.run({
      kind: 'custom',
      command: process.execPath,
      args: ['-e', 'console.log("check ok")'],
      timeoutMs: 10_000,
    }, createDvalinContext({ cwd: tmpDir, approvalMode: 'full-auto' }));

    expect(result.output).toContain('check ok');
    expect(result.metadata?.exitCode).toBe(0);
    expect(result.metadata?.kind).toBe('custom');
    expect(result.metadata?.sandbox).toBe('none');
  });

  it('enforces command policy inside run_check before spawning', async () => {
    const context = createDvalinContext({
      cwd: tmpDir,
      approvalMode: 'full-auto',
      policy: resolvePolicy([{ commands: { deny: ['do-not-run'] } }]),
    });

    await expect(runCheckTool.run({
      kind: 'custom',
      command: 'do-not-run',
      args: ['secret-arg'],
      timeoutMs: 10_000,
    }, context)).rejects.toThrow('command matches denylist');
  });
});
