import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJournal,
  completedTurn,
  danglingTurns,
  projectStatus,
  readJournal,
  recoverSession,
} from '../../src/sessions/journal.js';

describe('session journal', () => {
  let dir: string;
  const sid = 'dc_test_session';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-journal-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends and reads records in order with monotonic seq', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'hi', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'done', runId: 'r1', auditHead: 'abc', iterations: 2 }, dir);
    const records = readJournal(sid, dir);
    expect(records.map(r => r.seq)).toEqual([0, 1]);
    expect(records[0].type).toBe('turn_start');
    expect(records[1].type).toBe('turn_end');
  });

  it('reports idle when the last turn completed', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'hi', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'done', runId: 'r1' }, dir);
    expect(projectStatus(readJournal(sid, dir))).toBe('idle');
    expect(danglingTurns(readJournal(sid, dir))).toEqual([]);
  });

  it('detects an interrupted turn and preserves its input', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'do the thing', cwd: '/w', mode: 'code' }, dir);
    // process dies — no turn_end is written
    const records = readJournal(sid, dir);
    expect(projectStatus(records)).toBe('interrupted');
    const dangling = danglingTurns(records);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].content).toBe('do the thing');
  });

  it('recoverSession returns the dangling turn and closes it', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'lost work', cwd: '/w', mode: 'chat' }, dir);
    const recovered = recoverSession(sid, dir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].messageId).toBe('m1');
    // After recovery the journal is consistent: no longer interrupted, idempotent on re-run.
    const after = readJournal(sid, dir);
    expect(projectStatus(after)).toBe('idle');
    expect(after.at(-1)?.type).toBe('turn_interrupted');
    expect(recoverSession(sid, dir)).toEqual([]);
  });

  it('completedTurn enables idempotent replay only for finished turns', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'hi', cwd: '/w', mode: 'chat' }, dir);
    expect(completedTurn(readJournal(sid, dir), 'm1')).toBeUndefined();
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'done', runId: 'r1', auditHead: 'h1' }, dir);
    const hit = completedTurn(readJournal(sid, dir), 'm1');
    expect(hit?.runId).toBe('r1');
    expect(completedTurn(readJournal(sid, dir), 'other')).toBeUndefined();
  });

  it('an errored turn is terminal, not dangling, and not replayable', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'boom', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'error', runId: 'r1' }, dir);
    const records = readJournal(sid, dir);
    expect(projectStatus(records)).toBe('idle');
    expect(completedTurn(records, 'm1')).toBeUndefined();
  });

  it('returns empty for a session with no journal', () => {
    expect(readJournal('missing', dir)).toEqual([]);
    expect(projectStatus(readJournal('missing', dir))).toBe('idle');
  });
});
