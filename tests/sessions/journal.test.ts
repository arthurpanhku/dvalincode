import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendJournal,
  completedTurn,
  completedTurnResponse,
  danglingTurns,
  projectStatus,
  readJournal,
  recoverSession,
  unresolvedRecoveredTurns,
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
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'done', runId: 'r1', auditHead: 'h1', output: 'hello' }, dir);
    const hit = completedTurn(readJournal(sid, dir), 'm1');
    expect(hit?.runId).toBe('r1');
    expect(hit?.output).toBe('hello');
    expect(completedTurn(readJournal(sid, dir), 'other')).toBeUndefined();
  });

  it('completedTurnResponse is keyed by messageId when user content repeats', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'id-1', content: 'hi', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'id-1', status: 'done', runId: 'r1', output: 'answer A' }, dir);
    appendJournal(sid, { type: 'turn_start', messageId: 'id-2', content: 'hi', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'id-2', status: 'done', runId: 'r2', output: 'answer B' }, dir);
    const records = readJournal(sid, dir);
    expect(completedTurnResponse(records, 'id-1')).toBe('answer A');
    expect(completedTurnResponse(records, 'id-2')).toBe('answer B');
  });

  it('an errored turn is terminal, not dangling, and not replayable', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'boom', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'error', runId: 'r1' }, dir);
    const records = readJournal(sid, dir);
    expect(projectStatus(records)).toBe('idle');
    expect(completedTurn(records, 'm1')).toBeUndefined();
  });

  it('keeps a recovered turn reportable after recovery has closed it', () => {
    // The notice has to outlive the process that recovered the turn, otherwise
    // reloading the page loses it (#120). recoverSession closes the turn, so
    // danglingTurns goes quiet while the turn is still unresolved.
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'lost work', cwd: '/w', mode: 'chat' }, dir);
    recoverSession(sid, dir);
    const records = readJournal(sid, dir);
    expect(danglingTurns(records)).toEqual([]);
    const unresolved = unresolvedRecoveredTurns(records);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].messageId).toBe('m1');
    expect(unresolved[0].content).toBe('lost work');
  });

  it('resolves the notice when the same messageId completes', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'lost work', cwd: '/w', mode: 'chat' }, dir);
    recoverSession(sid, dir);
    expect(unresolvedRecoveredTurns(readJournal(sid, dir))).toHaveLength(1);
    // Re-sent under its original id, and this time it finishes.
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'lost work', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'done', output: 'done at last' }, dir);
    expect(unresolvedRecoveredTurns(readJournal(sid, dir))).toEqual([]);
  });

  it('keeps the notice when the re-sent turn fails or is interrupted again', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'lost work', cwd: '/w', mode: 'chat' }, dir);
    recoverSession(sid, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'error' }, dir);
    // An error is terminal but not success: the work is still unfinished.
    expect(unresolvedRecoveredTurns(readJournal(sid, dir))).toHaveLength(1);
  });

  it('reports one notice per interrupted turn, and none for a deliberate stop', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'first', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_start', messageId: 'm2', content: 'second', cwd: '/w', mode: 'chat' }, dir);
    recoverSession(sid, dir);
    // A user-pressed interrupt writes turn_end, never turn_interrupted.
    appendJournal(sid, { type: 'turn_start', messageId: 'm3', content: 'stopped by hand', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm3', status: 'interrupted' }, dir);
    const unresolved = unresolvedRecoveredTurns(readJournal(sid, dir));
    expect(unresolved.map(t => t.messageId)).toEqual(['m1', 'm2']);
  });

  it('does not report a turn twice when recovery runs again', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'lost work', cwd: '/w', mode: 'chat' }, dir);
    recoverSession(sid, dir);
    // A second crash after the notice was raised but before it was re-sent.
    appendJournal(sid, { type: 'turn_interrupted', messageId: 'm1', reason: 'crashed again' }, dir);
    expect(unresolvedRecoveredTurns(readJournal(sid, dir))).toHaveLength(1);
  });

  it('reports nothing to recover for a clean session', () => {
    appendJournal(sid, { type: 'turn_start', messageId: 'm1', content: 'hi', cwd: '/w', mode: 'chat' }, dir);
    appendJournal(sid, { type: 'turn_end', messageId: 'm1', status: 'done', output: 'hello' }, dir);
    expect(unresolvedRecoveredTurns(readJournal(sid, dir))).toEqual([]);
  });

  it('returns empty for a session with no journal', () => {
    expect(readJournal('missing', dir)).toEqual([]);
    expect(projectStatus(readJournal('missing', dir))).toBe('idle');
  });
});
