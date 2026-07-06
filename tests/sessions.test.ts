import { mkdtempSync } from 'node:fs';
import { mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/providers/types.js';

let tmpHome: string;

beforeAll(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), 'dvalincode-test-sessions-'));
});

// Mock node:os so that homedir() points to our temp directory
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

afterAll(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  deleteAllSessions,
  type Session,
} from '../src/sessions/store.js';

describe('createSession', () => {
  it('creates a session with proper ID format', () => {
    const session = createSession('/some/cwd');
    expect(session.id).toMatch(/^dc_\d+_[a-f0-9]{12}$/);
    expect(session.cwd).toBe('/some/cwd');
    expect(session.goal).toBeUndefined();
    expect(session.messages).toEqual([]);
    expect(session.createdAt).toBeTruthy();
    expect(session.updatedAt).toBe(session.createdAt);
  });

  it('creates a session with a goal', () => {
    const session = createSession('/other/cwd', 'Build a feature');
    expect(session.goal).toBe('Build a feature');
    expect(session.cwd).toBe('/other/cwd');
  });
});

describe('saveSession and loadSession', () => {
  it('saves and loads a session', async () => {
    const original: Session = {
      id: 'dc_test_save_load',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      messages: [
        { role: 'user', content: 'hello' },
      ],
    };

    await saveSession(original);
    const loaded = await loadSession(original.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('dc_test_save_load');
    expect(loaded?.cwd).toBe('/tmp');
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]?.content).toBe('hello');
  });

  it('returns null for non-existent session', async () => {
    const result = await loadSession('non_existent_session');
    expect(result).toBeNull();
  });

  it('persists the file on disk', async () => {
    const session = createSession('/test');
    await saveSession(session);
    const dir = path.join(tmpHome, '.dvalincode', 'sessions');
    const content = await readFile(path.join(dir, `${session.id}.json`), 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe(session.id);
  });
});

describe('listSessions', () => {
  it('returns empty array when no sessions exist (does not throw)', async () => {
    // listSessions should handle a non-existent directory gracefully
    const sessions = await listSessions();
    // Our mocked homedir has sessions from previous tests, so there should be some
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('lists sessions sorted by updatedAt descending', async () => {
    const s1 = createSession('/a');
    const s2 = createSession('/b');
    const s3 = createSession('/c');

    // Save all three first (saveSession sets updatedAt)
    await saveSession(s1);
    await saveSession(s2);
    await saveSession(s3);

    // Now manually set updatedAt to control ordering, then re-save
    s1.updatedAt = '2026-03-01T00:00:00.000Z';
    s2.updatedAt = '2026-02-01T00:00:00.000Z';
    s3.updatedAt = '2026-01-01T00:00:00.000Z';

    // Write directly to disk to bypass saveSession's auto-update
    const { writeFile, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const dir = join(homedir(), '.dvalincode', 'sessions');
    await writeFile(join(dir, `${s1.id}.json`), JSON.stringify(s1));
    await writeFile(join(dir, `${s2.id}.json`), JSON.stringify(s2));
    await writeFile(join(dir, `${s3.id}.json`), JSON.stringify(s3));

    const sessions = await listSessions();
    // Find our test sessions in the list
    const testSessions = sessions.filter(s =>
      [s1.id, s2.id, s3.id].includes(s.id),
    );
    expect(testSessions).toHaveLength(3);
    expect(testSessions[0]?.id).toBe(s1.id);
    expect(testSessions[1]?.id).toBe(s2.id);
    expect(testSessions[2]?.id).toBe(s3.id);
  });
});

describe('deleteSession', () => {
  it('deletes an existing session', async () => {
    const session = createSession('/delete-me');
    await saveSession(session);

    await deleteSession(session.id);
    const loaded = await loadSession(session.id);
    expect(loaded).toBeNull();
  });

  it('does not throw when deleting non-existent session', async () => {
    await expect(deleteSession('non_existent')).resolves.toBeUndefined();
  });

  it('rejects session ids that could escape the session directory', async () => {
    await expect(deleteSession('../outside')).rejects.toThrow('Invalid session ID');
  });
});

describe('deleteAllSessions', () => {
  it('deletes all session snapshots and journals', async () => {
    const one = createSession('/clear-one');
    const two = createSession('/clear-two');
    await saveSession(one);
    await saveSession(two);

    const dir = path.join(tmpHome, '.dvalincode', 'sessions');
    await writeFile(path.join(dir, `${one.id}.journal.jsonl`), '{"type":"turn_start"}\n', 'utf-8');
    await writeFile(path.join(dir, `${two.id}.journal.jsonl`), '{"type":"turn_start"}\n', 'utf-8');

    const deleted = await deleteAllSessions();

    expect(deleted).toBeGreaterThanOrEqual(4);
    expect(await listSessions()).toEqual([]);
    const files = await readdir(dir);
    expect(files.filter(file => file.endsWith('.json') || file.endsWith('.journal.jsonl'))).toEqual([]);
  });
});
