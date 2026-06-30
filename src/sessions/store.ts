import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ChatMessage } from '../providers/types.js';

function sanitizeId(id: string): string {
  // Allow only alphanumeric, underscore, and hyphen
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized !== id) {
    throw new Error(`Invalid session ID: contains disallowed characters`);
  }
  return id;
}

export type Session = {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  goal?: string;
  messages: ChatMessage[];
  /** Short summary of the session, generated after each turn */
  summary?: string;
  metadata?: Record<string, unknown>;
};

const STORE_VERSION = 2;

/** Sessions directory: ~/.dvalincode/sessions (overridable for tests). */
export function sessionsDir(): string {
  return process.env.DVALINCODE_SESSIONS_DIR ?? join(homedir(), '.dvalincode', 'sessions');
}

function sessionDir(): string {
  return sessionsDir();
}

export async function ensureSessionDir(): Promise<string> {
  const dir = sessionDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function createSession(cwd: string, goal?: string): Session {
  const id = `dc_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    cwd,
    goal,
    messages: [],
  };
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = new Date().toISOString();
  const dir = await ensureSessionDir();
  const filePath = join(dir, `${session.id}.json`);
  await writeFile(filePath, JSON.stringify(session, null, 2), 'utf-8');
}

export async function loadSession(id: string): Promise<Session | null> {
  const safeId = sanitizeId(id);
  const dir = sessionDir();
  const filePath = join(dir, `${safeId}.json`);
  try {
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as Session;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<Session[]> {
  const dir = sessionDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const sessions: Session[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await readFile(join(dir, file), 'utf-8');
      sessions.push(JSON.parse(data) as Session);
    } catch {
      continue;
    }
  }
  sessions.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return sessions;
}

export async function deleteSession(id: string): Promise<void> {
  const safeId = sanitizeId(id);
  const dir = sessionDir();
  const filePath = join(dir, `${safeId}.json`);
  await rm(filePath, { force: true });
}

/**
 * Generate a short summary of the session's latest turn for cross-session memory.
 * Uses the last assistant response and user message.
 */
export function summarizeSession(session: Session): string {
  const recent = session.messages.slice(-4);
  const userMsgs = recent.filter(m => m.role === 'user').slice(-2);
  const assistantMsgs = recent.filter(m => m.role === 'assistant').slice(-2);
  const toolMsgs = recent.filter(m => m.role === 'tool').slice(-2);

  const parts: string[] = [];
  if (userMsgs.length > 0) {
    parts.push(`User wanted: ${truncate(userMsgs[userMsgs.length - 1].content, 120)}`);
  }
  if (assistantMsgs.length > 0) {
    parts.push(`Assistant: ${truncate(assistantMsgs[assistantMsgs.length - 1].content, 200)}`);
  }
  if (toolMsgs.length > 0) {
    const tools = toolMsgs
      .map(m => m.content.match(/\[Tool (\w+) result\]/)?.[1])
      .filter(Boolean);
    if (tools.length > 0) {
      parts.push(`Tools used: ${tools.join(', ')}`);
    }
  }

  return parts.join(' | ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
