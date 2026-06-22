import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256, canonicalJSON } from './hash.js';

const execFileAsync = promisify(execFile);

/** A single event emitted during an agent run. */
export type AuditEvent =
  | {
      type: 'run_start';
      task: string;
      mode: string;
      provider: string;
      model: string;
      cwd: string;
      gitHead: string | null;
      /** SHA-256 of the resolved org policy governing this run (tamper-evidence). */
      policyHash?: string;
      /** Which policy files contributed, with their hashes and any load errors. */
      policySources?: { layer: 'machine' | 'repo'; path: string; present: boolean; hash: string | null; error?: string }[];
    }
  | { type: 'tool_call'; tool: string; argsSummary: string; status: 'ok' | 'error'; durationMs: number }
  | { type: 'file_read'; path: string; sha256: string }
  | { type: 'file_write'; path: string; added: number; removed: number; beforeHash: string | null; afterHash: string }
  | { type: 'file_delete'; path: string; beforeHash: string | null }
  | { type: 'shell_exec'; command: string; exitCode: number | null; sandbox: 'seatbelt' | 'bwrap' | 'none' }
  | { type: 'approval'; toolName: string; approved: boolean; diffHash?: string }
  | { type: 'policy_violation'; rule: string; tool: string; target: string }
  | {
      type: 'run_end';
      status: 'done' | 'interrupted' | 'error';
      iterations: number;
      inputTokens?: number;
      outputTokens?: number;
      warnings?: string[];
    };

/** A persisted record: an event plus chain metadata. */
export type AuditRecord = AuditEvent & { seq: number; ts: string; prevHash: string };

export type RunMeta = Omit<Extract<AuditEvent, { type: 'run_start' }>, 'type'>;

const MAX_SUMMARY = 512;

/** Default audit directory: ~/.dvalincode/audit (overridable for tests). */
export function defaultAuditDir(): string {
  return process.env.DVALINCODE_AUDIT_DIR ?? path.join(os.homedir(), '.dvalincode', 'audit');
}

function runFilePath(dir: string, runId: string): string {
  return path.join(dir, `run-${runId}.jsonl`);
}

/**
 * Append-only, hash-chained JSONL writer — one file per agent run. Every record
 * carries `prevHash`; the chain makes after-the-fact edits detectable. Writes are
 * best-effort: a failed append is counted and surfaced via run_end warnings, never
 * thrown into the agent loop.
 */
export class AuditSink {
  readonly runId: string;
  readonly file: string;
  private seq = 0;
  private prevHash: string;
  private warnings: string[] = [];

  constructor(runId: string, dir: string = defaultAuditDir()) {
    this.runId = runId;
    this.file = runFilePath(dir, runId);
    // Genesis link: chain anchored to the run id.
    this.prevHash = sha256(runId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.warnings.push(`audit dir create failed: ${errMsg(err)}`);
    }
  }

  /** Append one event. Truncates long free-text fields. Never throws. */
  append(event: AuditEvent): void {
    const trimmed = truncateFields(event);
    const record: AuditRecord = {
      ...trimmed,
      seq: this.seq,
      ts: new Date().toISOString(),
      prevHash: this.prevHash,
    } as AuditRecord;
    const hash = sha256(canonicalJSON(record));
    try {
      appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
      this.seq += 1;
      this.prevHash = hash;
    } catch (err) {
      this.warnings.push(`audit write failed at seq ${this.seq}: ${errMsg(err)}`);
    }
  }

  /** Warnings accumulated from failed writes — fold into the run_end event. */
  getWarnings(): string[] {
    return [...this.warnings];
  }
}

function truncateFields(event: AuditEvent): AuditEvent {
  if (event.type === 'tool_call') {
    return { ...event, argsSummary: clip(event.argsSummary) };
  }
  if (event.type === 'shell_exec') {
    return { ...event, command: clip(event.command) };
  }
  if (event.type === 'run_start') {
    return { ...event, task: clip(event.task) };
  }
  return event;
}

function clip(s: string): string {
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY) + '…' : s;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read and parse a run's JSONL into records. Throws if the file is missing. */
export function readRecords(runId: string, dir: string = defaultAuditDir()): AuditRecord[] {
  const file = runFilePath(dir, runId);
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as AuditRecord);
}

export type VerifyResult = { ok: boolean; brokenAtSeq?: number; reason?: string };

/**
 * Re-derive the hash chain and confirm every record links to the previous one.
 * Detects edits, insertions, deletions, and reordering.
 */
export function verifyChain(runId: string, dir: string = defaultAuditDir()): VerifyResult {
  let records: AuditRecord[];
  try {
    records = readRecords(runId, dir);
  } catch (err) {
    return { ok: false, reason: `cannot read run log: ${errMsg(err)}` };
  }

  let expectedPrev = sha256(runId);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.seq !== i) {
      return { ok: false, brokenAtSeq: i, reason: `seq mismatch: expected ${i}, found ${record.seq}` };
    }
    if (record.prevHash !== expectedPrev) {
      return { ok: false, brokenAtSeq: record.seq, reason: 'prevHash does not match preceding record' };
    }
    expectedPrev = sha256(canonicalJSON(record));
  }
  return { ok: true };
}

/** List run ids present in the audit dir, newest first. */
export function listRuns(dir: string = defaultAuditDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith('run-') && f.endsWith('.jsonl'))
    .map(f => f.slice('run-'.length, -'.jsonl'.length))
    .sort()
    .reverse();
}

/** Resolve the most recent run id, or null when none exist. */
export function latestRun(dir: string = defaultAuditDir()): string | null {
  return listRuns(dir)[0] ?? null;
}

/** Generate a sortable run id: timestamp + short random suffix. */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

/** Best-effort current git HEAD for the given cwd; null outside a repo. */
export async function resolveGitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
