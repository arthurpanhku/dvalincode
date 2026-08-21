import { spawn } from 'node:child_process';
import { runAgentTurn } from '../agent/session.js';
import type { SecurityCheckEvidence } from '../security/workflow.js';
import { verificationEvidenceFromAudit } from './automate.js';

/**
 * Who performs a remediation.
 *
 * Dvalin's own agent is one option, not the definition of the job. The trust
 * boundary is the verification gate — a deterministic re-scan plus recorded
 * check exit codes — and that gate does not care which agent wrote the patch.
 * Separating the two lets a better editor be adopted without moving the thing
 * that decides whether its work is acceptable.
 */
export type ExecutorId = 'dvalin' | 'codex';

export const EXECUTOR_IDS: ExecutorId[] = ['dvalin', 'codex'];

/** The subset of agent activity the remediation console renders. */
export type ExecutorEvent =
  | { type: 'tool_call'; name: string }
  | { type: 'tool_error'; name: string; error: string };

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
  /** Checks the executor ran, for the verification gate. */
  evidence: SecurityCheckEvidence[];
};

export type RemediationExecutor = {
  id: ExecutorId;
  name: string;
  /**
   * Whether `evidence` is read back from Dvalin's own tamper-evident audit
   * trail, rather than taken from the executor's report about itself.
   *
   * This is the honest difference between the backends and the reason it is on
   * the interface: an external executor can be asked what it ran, but its
   * answer is a claim, not an attestation.
   */
  attestsEvidence: boolean;
  /** `undefined` when usable; otherwise the reason it is not. */
  unavailableReason(): Promise<string | undefined>;
  run(request: ExecutorRequest, onEvent?: (event: ExecutorEvent) => void): Promise<ExecutorTurn>;
};

/** Dvalin's own agent: the existing behaviour, unchanged. */
export const dvalinAgentExecutor: RemediationExecutor = {
  id: 'dvalin',
  name: 'Dvalin agent',
  attestsEvidence: true,

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

    return {
      output: turn.result.output,
      session: turn.sessionId,
      // Exit codes out of the audit trail, not the model's prose about itself.
      evidence: turn.result.runId ? verificationEvidenceFromAudit(turn.result.runId) : [],
    };
  },
};

/**
 * OpenAI's Codex harness, through `codex exec`.
 *
 * `--json` is what makes this usable as a backend rather than a black box: the
 * stream carries the commands it ran as structured items, so the gate reads
 * events instead of parsing prose. They remain the executor's own account of
 * itself — see `attestsEvidence`.
 */
export const codexExecExecutor: RemediationExecutor = {
  id: 'codex',
  name: 'Codex (codex exec)',
  attestsEvidence: false,

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
  const evidence: SecurityCheckEvidence[] = [];

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

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      evidence.push({
        kind: 'codex command',
        command: item.command,
        exitCode,
        // `status` is the harness's own verdict. Prefer an exit code when the
        // stream carries one, since it is the thing that cannot be rephrased.
        passed: exitCode === null ? item.status === 'completed' : exitCode === 0,
      });
    }
  }

  return { output, session, evidence };
}

export function resolveExecutor(id: ExecutorId): RemediationExecutor {
  return id === 'codex' ? codexExecExecutor : dvalinAgentExecutor;
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
