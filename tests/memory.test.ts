import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDvalinContext } from '../src/core/context.js';
import { importMemory } from '../src/memory/importers.js';
import {
  addMemoryEntry,
  deleteMemoryEntry,
  renderRelevantMemory,
  searchMemory,
  updateMemoryEntry,
} from '../src/memory/store.js';
import { memorySearchTool } from '../src/tools/memorySearch.js';
import { memoryWriteTool } from '../src/tools/memoryWrite.js';

let tmpHome: string;
let tmpWorkspace: string;

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'dvalincode-memory-home-'));
  tmpWorkspace = mkdtempSync(path.join(os.tmpdir(), 'dvalincode-memory-ws-'));
  process.env.DVALINCODE_HOME = tmpHome;
});

afterEach(async () => {
  delete process.env.DVALINCODE_HOME;
  await rm(tmpHome, { recursive: true, force: true });
  await rm(tmpWorkspace, { recursive: true, force: true });
});

describe('memory store', () => {
  it('stores, searches, updates, and deletes project memory', async () => {
    const entry = await addMemoryEntry({
      scope: 'project',
      cwd: tmpWorkspace,
      kind: 'workflow',
      content: 'Run npm test before release.',
      tags: ['tests'],
      source: 'manual',
    });

    const found = await searchMemory('release test', { cwd: tmpWorkspace });
    expect(found[0]?.id).toBe(entry.id);

    const rendered = await renderRelevantMemory(tmpWorkspace, 'how do I test this project?');
    expect(rendered).toContain('Run npm test before release.');

    const updated = await updateMemoryEntry({
      id: entry.id,
      cwd: tmpWorkspace,
      content: 'Run npm run check before release.',
      tags: ['checks'],
    });
    expect(updated?.content).toContain('npm run check');

    await expect(deleteMemoryEntry({ id: entry.id, cwd: tmpWorkspace })).resolves.toBe(true);
    await expect(searchMemory('release test', { cwd: tmpWorkspace })).resolves.toHaveLength(0);
  });

  it('imports markdown candidates', async () => {
    const source = path.join(tmpWorkspace, 'CLAUDE.md');
    writeFileSync(source, '- Prefer pnpm for package commands.\n- API tests require local Redis.\n', 'utf-8');

    const dryRun = await importMemory({
      source: 'claude',
      sourcePath: source,
      cwd: tmpWorkspace,
      dryRun: true,
    });
    expect(dryRun.candidates).toHaveLength(2);
    expect(dryRun.imported).toBe(0);

    const imported = await importMemory({
      source: 'claude',
      sourcePath: source,
      cwd: tmpWorkspace,
    });
    expect(imported.imported).toBe(2);

    const found = await searchMemory('Redis', { cwd: tmpWorkspace });
    expect(found[0]?.content).toContain('Redis');
  });
});

describe('memory tools', () => {
  it('writes and searches memory via tools', async () => {
    const context = createDvalinContext({ cwd: tmpWorkspace, approvalMode: 'full-auto' });
    const written = await memoryWriteTool.run({
      scope: 'project',
      kind: 'decision',
      content: 'Use hash-chained audit logs for trust.',
      tags: ['audit'],
      confidence: 0.9,
    }, context);

    expect(written.output).toContain('Saved memory');

    const searched = await memorySearchTool.run({
      query: 'audit trust',
      maxResults: 5,
    }, context);

    expect(searched.output).toContain('hash-chained audit logs');
  });
});
