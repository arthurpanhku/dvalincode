import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// `runAgentTurn` runs for real below -- session store, journal, agent loop and
// tools -- against a scripted model. These stubs keep the developer's own
// provider, pool and MCP configuration out of it, so nothing reaches a network.
const chat = vi.hoisted(() => vi.fn());
vi.mock('../../src/server/configStore.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/server/configStore.js')>();
  return { ...actual, readConfig: async () => ({ llm: { provider: 'mock', model: 'mock-model' } }) };
});
vi.mock('../../src/providers/manager.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/providers/manager.js')>();
  class ScriptedProviderManager {
    addConfigured() {
      return this;
    }
    get() {
      return { name: 'mock', chat };
    }
  }
  return { ...actual, ProviderManager: ScriptedProviderManager };
});

import {
  resolveApprovalMode,
  MODE_APPROVAL,
  MODE_TOOLS,
  CODE_PERMISSION_APPROVAL,
} from '../../src/agent/modes.js';
import { expandAtMentions, runAgentTurn } from '../../src/agent/session.js';
import { createDefaultToolRegistry } from '../../src/tools/registry.js';
import { createDvalinContext } from '../../src/core/context.js';
import { ProviderHttpError } from '../../src/providers/retry.js';
import { loadSession } from '../../src/sessions/store.js';
import { readJournal } from '../../src/sessions/journal.js';

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
    expect(resolveApprovalMode('dvalin', 'plan')).toBe('readonly');
    expect(resolveApprovalMode('dvalin', 'auto')).toBe('full-auto');
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
      'list_skills',
      'read_skill',
      'list_remediation_cases',
    ]);
    const registry = createDefaultToolRegistry();
    for (const name of MODE_TOOLS.chat ?? []) {
      expect(registry.get(name)?.access).toBe('read');
    }
    expect(MODE_TOOLS.cowork).toBeNull();
    expect(MODE_TOOLS.code).toBeNull();
    expect(MODE_TOOLS.dvalin).toBeNull();
    expect(CODE_PERMISSION_APPROVAL.plan).toBe('readonly');
  });

  it('auto-approves every runtime request in bypass mode', async () => {
    let prompts = 0;
    const context = createDvalinContext({
      approvalMode: 'bypass',
      requestApproval: async () => {
        prompts++;
        return false;
      },
    });

    await expect(context.requestApproval?.('approval-1', 'shell_sandbox_bypass', {
      networkAccess: 'unrestricted',
    })).resolves.toBe(true);
    expect(prompts).toBe(0);
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

describe('runAgentTurn', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'dvalin-turn-')));
    process.env.DVALINCODE_SESSIONS_DIR = path.join(dir, 'sessions');
    process.env.DVALINCODE_HOME = dir;
    // Points at no file, so no machine policy from the developer's home applies.
    process.env.DVALINCODE_POLICY_FILE = path.join(dir, 'policy.json');
    chat.mockReset();
  });
  afterEach(() => {
    delete process.env.DVALINCODE_SESSIONS_DIR;
    delete process.env.DVALINCODE_HOME;
    delete process.env.DVALINCODE_POLICY_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves the messages a turn finished before the provider failed', async () => {
    const cwd = path.join(dir, 'workspace');
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, 'a.txt'), 'old\n', 'utf8');
    const failure = new ProviderHttpError(503, 'overloaded');
    chat
      .mockResolvedValueOnce({
        content: '',
        model: 'mock-model',
        toolCalls: [
          { id: 'call_read', name: 'read_file', arguments: '{"filePath":"a.txt"}' },
          { id: 'call_write', name: 'write_file', arguments: '{"filePath":"a.txt","content":"new\\n"}' },
        ],
      })
      .mockRejectedValueOnce(failure);

    let sessionId = '';
    // The same error object, not a wrapper: the harness maps its type to an exit code.
    await expect(
      runAgentTurn({ content: 'update a.txt', cwd, mode: 'code' }, { onSessionId: id => { sessionId = id; } }),
    ).rejects.toBe(failure);

    // The edit reached the workspace before the provider failed...
    expect(readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('new\n');
    // ...so the saved session has to record it, up to the last finished message.
    const saved = await loadSession(sessionId);
    expect(saved?.messages.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(saved?.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_write' });
    // The turn still did not complete, so resending its messageId runs it again.
    expect(readJournal(sessionId).at(-1)).toMatchObject({ type: 'turn_end', status: 'error' });
  });
});
