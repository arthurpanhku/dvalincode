import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { runAgentTurn } from '../agent/session.js';

/**
 * Who performs a remediation.
 *
 * An executor edits code. That is the whole job: Dvalin runs the project's
 * checks itself and re-scans independently, so nothing here is trusted and
 * there is no trust surface on this interface to get wrong. Choosing an
 * executor is a question of cost and quality, not of what it may be believed
 * about.
 */
export type ExecutorId = 'dvalin' | 'codex' | 'claude-code';

export const EXECUTOR_IDS: ExecutorId[] = ['dvalin', 'codex', 'claude-code'];

/** The subset of agent activity the remediation console renders. */
export type ExecutorEvent =
  | { type: 'tool_call'; name: string }
  | { type: 'tool_error'; name: string; error: string }
  /** Something the person should know about how the executor is running. */
  | { type: 'notice'; message: string };

export type ExecutorRequest = {
  prompt: string;
  cwd: string;
  /** Continue the conversation a previous turn started. */
  resume?: string;
  /** Override the model provider, where the executor has one to override. */
  provider?: string;
};

export type ExecutorTurn = {
  /** The executor's final message. Callers read it for a summary or a PR URL. */
  output: string;
  /** Handle for continuing this conversation in a later turn. */
  session?: string;
};

export type RemediationExecutor = {
  id: ExecutorId;
  name: string;
  /** `undefined` when usable; otherwise the reason it is not. */
  unavailableReason(): Promise<string | undefined>;
  run(request: ExecutorRequest, onEvent?: (event: ExecutorEvent) => void): Promise<ExecutorTurn>;
};

/** Dvalin's own agent: the existing behaviour, unchanged. */
export const dvalinAgentExecutor: RemediationExecutor = {
  id: 'dvalin',
  name: 'Dvalin agent',

  async unavailableReason() {
    return undefined;
  },

  async run(request, onEvent) {
    const turn = await runAgentTurn(
      {
        content: request.prompt,
        cwd: request.cwd,
        sessionId: request.resume,
        mode: 'dvalin',
        codePermissionMode: 'bypass',
        providerOverride: request.provider,
      },
      {
        onEvent: event => {
          if (event.type === 'tool_call') onEvent?.({ type: 'tool_call', name: event.name });
          if (event.type === 'tool_error') onEvent?.({ type: 'tool_error', name: event.name, error: event.error });
        },
      },
    );

    return { output: turn.result.output, session: turn.sessionId };
  },
};

/**
 * OpenAI's Codex harness, through `codex exec`.
 *
 * `--json` is what makes this usable as a backend rather than a black box:
 * `thread.started` carries the handle that `codex exec resume` needs, which is
 * what keeps fix and publish in one conversation, and completed commands stream
 * out as structured items so a long remediation is not silent.
 */
export const codexExecExecutor: RemediationExecutor = {
  id: 'codex',
  name: 'Codex (codex exec)',

  async unavailableReason() {
    const found = await new Promise<boolean>(resolve => {
      const probe = spawn('codex', ['--version'], { stdio: 'ignore' });
      probe.on('error', () => resolve(false));
      probe.on('close', code => resolve(code === 0));
    });
    if (!found) return 'the `codex` CLI is not on PATH — install it with `npm i -g @openai/codex`';
    if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
      return 'neither CODEX_API_KEY nor OPENAI_API_KEY is set, and `codex exec` needs credentials in automation';
    }
    return undefined;
  },

  async run(request, onEvent) {
    // `workspace-write` is the least permission that still lets a remediation
    // edit code. The isolated worktree, not the sandbox, is what keeps the
    // original workspace out of reach.
    const args = request.resume
      ? ['exec', 'resume', request.resume, '--json', '--sandbox', 'workspace-write', request.prompt]
      : ['exec', '--json', '--sandbox', 'workspace-write', request.prompt];

    const { stdout, stderr, code } = await runCodex(args, request.cwd, onEvent);
    if (code !== 0) {
      throw new Error(`codex exec exited ${code}: ${stderr.trim().slice(0, 500) || 'no stderr'}`);
    }
    return parseCodexStream(stdout);
  },
};

/**
 * Read a `codex exec --json` JSONL stream.
 *
 * Exported for its own sake: the parsing is the part worth testing, and it can
 * be exercised against recorded output without a model or a network.
 */
export function parseCodexStream(stdout: string): ExecutorTurn {
  let output = '';
  let session: string | undefined;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Anything the harness prints that is not an event is not ours to read.
      continue;
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      session = event.thread_id;
      continue;
    }

    if (event.type !== 'item.completed') continue;
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) continue;

    // The last agent message is the turn's result; earlier ones are progress.
    if (item.type === 'agent_message' && typeof item.text === 'string') output = item.text;
  }

  return { output, session };
}

/**
 * Anthropic's Claude Code, through `claude -p`.
 *
 * Like Codex, it gets the least permission that still lets it repair code:
 * file edits are accepted, and shell commands run only inside Claude Code's own
 * sandbox. That sandbox needs Seatbelt on macOS, or bubblewrap and socat on
 * Linux, and when they are missing Claude Code runs commands unsandboxed with
 * a warning rather than refusing. Dvalin does not accept that: without the
 * sandbox the executor gets no shell at all and edits only — Dvalin runs the
 * project's checks itself either way — and if Claude Code announces it is
 * running unsandboxed anyway, the turn is stopped.
 */
export const claudeCodeExecutor: RemediationExecutor = {
  id: 'claude-code',
  name: 'Claude Code (claude -p)',

  async unavailableReason() {
    const found = await new Promise<boolean>(resolve => {
      const probe = spawn('claude', ['--version'], { stdio: 'ignore', env: claudeChildEnv(process.env) });
      probe.on('error', () => resolve(false));
      probe.on('close', code => resolve(code === 0));
    });
    if (!found) return 'the `claude` CLI is not on PATH — install Claude Code with `npm i -g @anthropic-ai/claude-code`';
    return undefined;
  },

  async run(request, onEvent) {
    const sandbox = await claudeSandboxSupport();
    if (!sandbox.available) {
      onEvent?.({
        type: 'notice',
        message: `Claude Code's sandbox needs ${sandbox.missing.join(' and ')}; running it without a shell (edits only). Dvalin still runs the checks.`,
      });
    }
    const args = buildClaudeArgs(request, sandbox.available);
    const { stdout, stderr, code, unsandboxed } = await runClaude(args, request.cwd, sandbox.available, onEvent);
    if (unsandboxed) {
      throw new Error(`Claude Code reported it would run commands without its sandbox, so the turn was stopped: ${firstLine(unsandboxed)}`);
    }
    const turn = parseClaudeStream(stdout);
    if (turn.error) throw new Error(`Claude Code failed: ${turn.error}`);
    if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500) || 'no stderr'}`);
    return { output: turn.output, session: turn.session };
  },
};

/** The sandbox Claude Code's shell sandbox depends on, by platform. */
export async function claudeSandboxSupport(platform: NodeJS.Platform = process.platform): Promise<{ available: boolean; missing: string[] }> {
  const needed = platform === 'darwin' ? ['sandbox-exec'] : platform === 'linux' ? ['bwrap', 'socat'] : [];
  if (!needed.length) return { available: false, missing: [`a supported platform (not ${platform})`] };
  const missing: string[] = [];
  for (const command of needed) if (!(await onPath(command))) missing.push(command);
  return { available: missing.length === 0, missing };
}

/** Exported for tests: the exact command line is the permission boundary. */
export function buildClaudeArgs(request: ExecutorRequest, sandboxed: boolean): string[] {
  const settings = { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false } };
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'acceptEdits',
    ...(sandboxed ? ['--settings', JSON.stringify(settings)] : ['--disallowedTools', 'Bash']),
    ...(request.resume ? ['--resume', request.resume] : []),
    // After `--`, a prompt can never be read as a flag.
    '--',
    request.prompt,
  ];
}

/**
 * The environment for a nested `claude`. When Dvalin itself runs inside a
 * Claude Code session, these variables would attach the executor to that
 * session — its conversation, not a fresh one. Credentials and configuration
 * pass through unchanged.
 */
export function claudeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of ['CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_REMOTE_SESSION_ID']) {
    delete out[key];
  }
  return out;
}

/**
 * Read a `claude -p --output-format stream-json` stream.
 *
 * Exported for its own sake, as with Codex: parsing is the part worth testing,
 * against recorded output, without a model or a network.
 */
export function parseClaudeStream(stdout: string): ExecutorTurn & { error?: string } {
  let output = '';
  let session: string | undefined;
  let error: string | undefined;

  for (const line of stdout.split('\n')) {
    const event = parseJsonLine(line);
    if (!event) continue;
    if (typeof event.session_id === 'string' && event.type === 'system' && event.subtype === 'init') session = event.session_id;
    if (event.type !== 'result') continue;
    if (typeof event.session_id === 'string') session = event.session_id;
    if (typeof event.result === 'string') output = event.result;
    // A turn that ended badly says so here: an API or auth error, or a turn
    // limit. That is a failed turn, not an empty answer.
    if (event.is_error === true || (typeof event.subtype === 'string' && event.subtype !== 'success')) {
      error = (typeof event.result === 'string' && event.result.trim()) || String(event.subtype ?? 'error');
    }
  }

  return { output, session, ...(error ? { error } : {}) };
}

export function resolveExecutor(id: ExecutorId): RemediationExecutor {
  if (id === 'codex') return codexExecExecutor;
  if (id === 'claude-code') return claudeCodeExecutor;
  return dvalinAgentExecutor;
}

/** Claude Code's notice that the sandbox was asked for but is not in force. */
const UNSANDBOXED = /run WITHOUT sandboxing|Sandbox disabled/i;

function runClaude(
  args: string[],
  cwd: string,
  sandboxed: boolean,
  onEvent?: (event: ExecutorEvent) => void,
): Promise<{ stdout: string; stderr: string; code: number | null; unsandboxed?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: claudeChildEnv(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let unsandboxed: string | undefined;

    child.stdout.on('data', chunk => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) reportClaudeLine(line, onEvent);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      // The warning comes at startup, before the first tool call. Stop there.
      if (sandboxed && !unsandboxed && UNSANDBOXED.test(stderr)) {
        unsandboxed = stderr.slice(Math.max(0, stderr.search(UNSANDBOXED) - 80));
        child.kill('SIGTERM');
      }
    });
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, code, ...(unsandboxed ? { unsandboxed } : {}) }));
  });
}

function reportClaudeLine(line: string, onEvent?: (event: ExecutorEvent) => void): void {
  if (!onEvent) return;
  const event = parseJsonLine(line);
  const message = event?.message as { content?: unknown } | undefined;
  if (!event || !Array.isArray(message?.content)) return;
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
      const input = block.input as { command?: unknown; file_path?: unknown } | undefined;
      const detail = typeof input?.command === 'string' ? input.command : typeof input?.file_path === 'string' ? input.file_path : '';
      onEvent({ type: 'tool_call', name: detail ? `${block.name} ${firstLine(detail)}` : block.name });
    }
    if (event.type === 'user' && block.type === 'tool_result' && block.is_error === true) {
      const content = typeof block.content === 'string' ? block.content : 'tool failed';
      onEvent({ type: 'tool_error', name: 'tool', error: firstLine(content) });
    }
  }
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    // Anything the harness prints that is not an event is not ours to read.
    return undefined;
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.slice(0, 160);
}

async function onPath(command: string): Promise<boolean> {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    try {
      await access(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Keep looking.
    }
  }
  // Seatbelt's launcher lives outside most PATHs on macOS.
  if (command === 'sandbox-exec') {
    try {
      await access('/usr/bin/sandbox-exec', constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function runCodex(
  args: string[],
  cwd: string,
  onEvent?: (event: ExecutorEvent) => void,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';

    child.stdout.on('data', chunk => {
      stdout += chunk;
      // Report commands as they complete, so a long remediation is not silent.
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) reportCodexLine(line, onEvent);
    });
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ stdout, stderr, code }));
  });
}

function reportCodexLine(line: string, onEvent?: (event: ExecutorEvent) => void): void {
  if (!onEvent || !line.trim()) return;
  try {
    const event = JSON.parse(line) as { type?: string; item?: { type?: string; command?: string; status?: string } };
    const item = event.item;
    if (event.type !== 'item.completed' || item?.type !== 'command_execution' || !item.command) return;
    if (item.status === 'failed') onEvent({ type: 'tool_error', name: item.command, error: 'command failed' });
    else onEvent({ type: 'tool_call', name: item.command });
  } catch {
    // Not an event line.
  }
}
