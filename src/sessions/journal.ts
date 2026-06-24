import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sessionsDir } from './store.js';

/**
 * Durable session journal — an append-only JSONL record of every turn's intent
 * and outcome, one file per session (see docs/DURABLE-SESSION.md). It mirrors the
 * audit log's append-only shape, but it is **session state**, not the audit
 * chain: it may hold the user's raw message text so an interrupted turn can be
 * recovered intact. It is linked to the audit chain only by ids and the audit
 * checkpoint hash, never by copying content across that boundary.
 */

export type JournalTurnStart = {
  type: 'turn_start';
  messageId: string;
  /** Raw user message — preserved so a crashed turn is not lost. */
  content: string;
  cwd: string;
  mode: string;
};

export type JournalTurnEnd = {
  type: 'turn_end';
  messageId: string;
  status: 'done' | 'error' | 'interrupted';
  /** Audit run this turn produced, if any. */
  runId?: string;
  /** Audit chain head hash after run_end — the checkpoint anchor. */
  auditHead?: string;
  iterations?: number;
};

export type JournalTurnInterrupted = {
  type: 'turn_interrupted';
  messageId: string;
  reason: string;
};

export type JournalEvent = JournalTurnStart | JournalTurnEnd | JournalTurnInterrupted;

/** A persisted journal record: an event plus ordering metadata. */
export type JournalRecord = JournalEvent & { seq: number; ts: string };

/** Status derived from the journal tail. `running` is in-memory only and never persisted. */
export type SessionStatus = 'idle' | 'interrupted';

function journalPath(sessionId: string, dir: string = sessionsDir()): string {
  return join(dir, `${sessionId}.journal.jsonl`);
}

/** Read a session's journal, oldest record first. Returns [] when absent or unreadable. */
export function readJournal(sessionId: string, dir: string = sessionsDir()): JournalRecord[] {
  const file = journalPath(sessionId, dir);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records: JournalRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch {
      // Skip a corrupt line rather than failing the whole read.
    }
  }
  return records;
}

/**
 * Append one event to a session's journal. Best-effort and never throws — a
 * failed write must not break the turn (it degrades durability, like the audit
 * sink). The next `seq` is derived from the existing record count.
 */
export function appendJournal(sessionId: string, event: JournalEvent, dir: string = sessionsDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const seq = readJournal(sessionId, dir).length;
    const record: JournalRecord = { ...event, seq, ts: new Date().toISOString() } as JournalRecord;
    appendFileSync(journalPath(sessionId, dir), JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // Durability is best-effort; the snapshot remains the canonical projection.
  }
}

/** Message ids that have reached a terminal record (turn_end or turn_interrupted). */
function closedMessageIds(records: JournalRecord[]): Set<string> {
  const closed = new Set<string>();
  for (const r of records) {
    if (r.type === 'turn_end' || r.type === 'turn_interrupted') closed.add(r.messageId);
  }
  return closed;
}

/** The successful `turn_end` for a message id, if the turn already completed. */
export function completedTurn(records: JournalRecord[], messageId: string): JournalTurnEnd | undefined {
  return records.find(
    (r): r is JournalTurnEnd & { seq: number; ts: string } =>
      r.type === 'turn_end' && r.messageId === messageId && r.status === 'done',
  );
}

/** Turn starts that never reached a terminal record — i.e. crashed mid-turn. */
export function danglingTurns(records: JournalRecord[]): JournalTurnStart[] {
  const closed = closedMessageIds(records);
  const seen = new Set<string>();
  const dangling: JournalTurnStart[] = [];
  for (const r of records) {
    if (r.type !== 'turn_start') continue;
    if (closed.has(r.messageId) || seen.has(r.messageId)) continue;
    seen.add(r.messageId);
    dangling.push(r);
  }
  return dangling;
}

/** Derive session status from its journal. */
export function projectStatus(records: JournalRecord[]): SessionStatus {
  return danglingTurns(records).length > 0 ? 'interrupted' : 'idle';
}

/**
 * Close out any turn that started but never finished (a hard crash before
 * `turn_end`). Returns the dangling turns — with their original `messageId` and
 * `content` preserved — so the caller can choose to re-run or discard. Appends a
 * `turn_interrupted` record for each so the journal becomes consistent and the
 * same turn is not reported as interrupted forever.
 */
export function recoverSession(sessionId: string, dir: string = sessionsDir()): JournalTurnStart[] {
  const dangling = danglingTurns(readJournal(sessionId, dir));
  for (const turn of dangling) {
    appendJournal(
      sessionId,
      { type: 'turn_interrupted', messageId: turn.messageId, reason: 'no turn_end on load (process ended mid-turn)' },
      dir,
    );
  }
  return dangling;
}
