import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportData, importData, isDataBundle, DATA_BUNDLE_VERSION } from '../../src/data/archive.js';

let src: string;
let dest: string;

beforeEach(() => {
  src = mkdtempSync(path.join(tmpdir(), 'dvalin-src-'));
  dest = mkdtempSync(path.join(tmpdir(), 'dvalin-dest-'));
  // Seed a representative ~/.dvalincode tree.
  writeFileSync(path.join(src, 'config.json'), '{"llm":{"provider":"deepseek"}}');
  mkdirSync(path.join(src, 'sessions'), { recursive: true });
  writeFileSync(path.join(src, 'sessions', 'dc_1.json'), '{"id":"dc_1","messages":[]}');
  mkdirSync(path.join(src, 'memory', 'user'), { recursive: true });
  writeFileSync(path.join(src, 'memory', 'user', 'entries.json'), '[{"id":"mem_1"}]');
  mkdirSync(path.join(src, 'audit'), { recursive: true });
  writeFileSync(path.join(src, 'audit', 'run-x.jsonl'), '{"seq":0}\n');
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(dest, { recursive: true, force: true });
});

describe('data archive', () => {
  it('exports all local files into a bundle', async () => {
    const bundle = await exportData({ home: src });
    expect(bundle.app).toBe('dvalincode');
    expect(bundle.version).toBe(DATA_BUNDLE_VERSION);
    expect(Object.keys(bundle.files).sort()).toEqual([
      'audit/run-x.jsonl',
      'config.json',
      'memory/user/entries.json',
      'sessions/dc_1.json',
    ]);
    expect(isDataBundle(bundle)).toBe(true);
  });

  it('can exclude audit logs', async () => {
    const bundle = await exportData({ home: src, includeAudit: false });
    expect(Object.keys(bundle.files)).not.toContain('audit/run-x.jsonl');
    expect(Object.keys(bundle.files)).toContain('sessions/dc_1.json');
  });

  it('round-trips export → import into a fresh home', async () => {
    const bundle = await exportData({ home: src });
    const result = await importData(bundle, { home: dest });
    expect(result.written).toBe(4);
    expect(result.total).toBe(4);
    expect(readFileSync(path.join(dest, 'config.json'), 'utf-8')).toContain('deepseek');
    expect(readFileSync(path.join(dest, 'memory/user/entries.json'), 'utf-8')).toContain('mem_1');
    expect(existsSync(path.join(dest, 'audit/run-x.jsonl'))).toBe(true);
  });

  it('skips existing files when overwrite is false', async () => {
    writeFileSync(path.join(dest, 'config.json'), 'OLD');
    const bundle = await exportData({ home: src });
    const result = await importData(bundle, { home: dest, overwrite: false });
    expect(result.skipped).toBe(1);
    expect(readFileSync(path.join(dest, 'config.json'), 'utf-8')).toBe('OLD');
  });

  it('rejects path traversal in bundle keys', async () => {
    const evil = { app: 'dvalincode' as const, version: 1, exportedAt: 'x', files: { '../escape.txt': 'pwn' } };
    const result = await importData(evil, { home: dest });
    expect(result.skipped).toBe(1);
    expect(result.written).toBe(0);
    expect(existsSync(path.join(path.dirname(dest), 'escape.txt'))).toBe(false);
  });

  it('rejects non-bundles', async () => {
    expect(isDataBundle({ foo: 1 })).toBe(false);
    await expect(importData({ foo: 1 } as never, { home: dest })).rejects.toThrow();
  });
});
