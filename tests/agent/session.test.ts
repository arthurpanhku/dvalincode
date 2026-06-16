import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveApprovalMode,
  MODE_APPROVAL,
  MODE_TOOLS,
  CODE_PERMISSION_APPROVAL,
} from '../../src/agent/modes.js';
import { expandAtMentions } from '../../src/agent/session.js';
import { createDefaultToolRegistry } from '../../src/tools/registry.js';

describe('resolveApprovalMode', () => {
  it('maps non-code modes directly', () => {
    expect(resolveApprovalMode('chat', 'auto')).toBe('readonly');
    expect(resolveApprovalMode('cowork', 'auto')).toBe('auto-edit');
  });

  it('uses the code permission mode within code', () => {
    expect(resolveApprovalMode('code', 'ask')).toBe('auto-edit');
    expect(resolveApprovalMode('code', 'plan')).toBe('readonly');
    expect(resolveApprovalMode('code', 'auto')).toBe('full-auto');
    expect(resolveApprovalMode('code', 'bypass')).toBe('bypass');
  });

  it('keeps chat read-only and gives cowork/code write access', () => {
    expect(MODE_APPROVAL.chat).toBe('readonly');
    expect(MODE_TOOLS.chat).toEqual([
      'read_file',
      'list_files',
      'search_text',
      'git_status',
      'git_diff',
      'project_scripts',
      'memory_search',
    ]);
    const registry = createDefaultToolRegistry();
    for (const name of MODE_TOOLS.chat ?? []) {
      expect(registry.get(name)?.access).toBe('read');
    }
    expect(MODE_TOOLS.cowork).toBeNull();
    expect(CODE_PERMISSION_APPROVAL.plan).toBe('readonly');
  });
});

describe('expandAtMentions', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'dvalin-mention-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('inlines the contents of a mentioned file', async () => {
    writeFileSync(path.join(dir, 'note.txt'), 'hello world', 'utf8');
    const out = await expandAtMentions('look at @note.txt please', dir);
    expect(out).toContain('<file path="note.txt">');
    expect(out).toContain('hello world');
  });

  it('leaves a mention for a missing file unchanged', async () => {
    const out = await expandAtMentions('check @nope.txt', dir);
    expect(out).toBe('check @nope.txt');
  });

  it('does not inline a directory', async () => {
    mkdirSync(path.join(dir, 'sub'));
    const out = await expandAtMentions('see @sub', dir);
    expect(out).toBe('see @sub');
  });

  it('returns the message untouched when there are no mentions', async () => {
    const out = await expandAtMentions('plain message', dir);
    expect(out).toBe('plain message');
  });
});
