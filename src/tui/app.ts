import readline from 'node:readline';
import { homedir } from 'node:os';
import chalk from 'chalk';

import { runAgentTurn, resolveProvider } from '../agent/session.js';
import type { AgentEvent } from '../agent/types.js';
import type { AgentMode, CodePermissionMode } from '../agent/modes.js';
import { readConfig, writeConfig } from '../server/configStore.js';
import { PROVIDER_PRESETS, findPreset } from './presets.js';
import * as R from './render.js';

export type TuiOptions = { cwd?: string; mode?: AgentMode };

type AskLine = (query: string) => Promise<string | null>;

/** Launch the interactive terminal agent. Drives the same `runAgentTurn` the
 * web GUI uses, with stdout streaming and stdin approval. */
export async function runTui(opts: TuiOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  let mode: AgentMode = opts.mode ?? 'chat';
  let codePermissionMode: CodePermissionMode = 'ask';
  let sessionId: string | undefined;
  let activeAbort: AbortController | null = null;
  let interruptRequested = false;
  let exiting = false;
  let closed = false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask: AskLine = (query: string) => askLine(rl, query, () => closed);

  const shutdown = (): void => {
    exiting = true;
    activeAbort?.abort();
    if (!closed) rl.close();
  };

  const forceExit = (): void => {
    process.stdout.write(chalk.yellow('\n  forcing exit\n'));
    shutdown();
    process.exit(130);
  };

  process.stdout.write(R.banner());

  const configured = await ensureConfigured(rl, ask);
  if (!configured) {
    shutdown();
    return;
  }

  let providerModel = 'unconfigured';
  try {
    const r = await resolveProvider();
    providerModel = `${r.providerId}/${r.model}`;
  } catch {
    // leave as unconfigured; the first turn will surface a clear error
  }
  const cwdDisplay = cwd.startsWith(homedir()) ? cwd.replace(homedir(), '~') : cwd;

  // Ctrl-C: interrupt a running turn, or exit at an idle prompt.
  rl.on('SIGINT', () => {
    if (activeAbort) {
      if (interruptRequested) {
        forceExit();
        return;
      }
      interruptRequested = true;
      activeAbort.abort();
      process.stdout.write(chalk.yellow('\n  interrupt requested — press Ctrl-C again to force exit\n'));
    } else {
      process.stdout.write('\n');
      shutdown();
    }
  });
  rl.on('close', () => {
    closed = true;
    exiting = true;
  });

  // Approval gate for Cowork / Code-Ask writes and commands.
  const requestApproval = async (_id: string, toolName: string, input: unknown): Promise<boolean> => {
    const signal = activeAbort?.signal;
    const answer = await askLine(rl, '\n' + R.approvalLine(toolName, input), () => closed, signal);
    if (signal?.aborted) throw new Error('interrupted');
    if (answer === null) return false;
    return /^y(es)?$/i.test(answer.trim());
  };

  async function runTurn(content: string): Promise<void> {
    const abort = new AbortController();
    activeAbort = abort;
    let sawToken = false;

    const onEvent = (event: AgentEvent): void => {
      switch (event.type) {
        case 'token_delta':
          process.stdout.write(event.content);
          sawToken = true;
          break;
        case 'tool_call':
          process.stdout.write('\n' + R.formatToolCall(event.name, event.input) + '\n');
          break;
        case 'tool_result':
          process.stdout.write(R.formatToolResult(event.output) + '\n');
          break;
        case 'tool_error':
          process.stdout.write(R.formatToolError(event.name, event.error) + '\n');
          break;
      }
    };

    try {
      const turn = await runAgentTurn(
        { content, sessionId, cwd, mode, codePermissionMode, signal: abort.signal, origin: 'tui' },
        { onEvent, requestApproval },
      );
      sessionId = turn.sessionId;
      for (const recovered of turn.recovered ?? []) {
        process.stdout.write('\n' + R.formatRecoveredTurnNotice(recovered.content) + '\n');
      }
      if (!sawToken && turn.result.output) {
        process.stdout.write(turn.result.output + '\n');
      } else {
        process.stdout.write('\n');
      }
      if (turn.result.runId) {
        process.stdout.write(chalk.dim(`  🔒 audit ${turn.result.runId} — dvalincode report --last\n`));
      }
    } catch (err) {
      if (abort.signal.aborted) {
        process.stdout.write(chalk.yellow('\n  ⏹ interrupted\n'));
      } else {
        process.stdout.write(chalk.red(`\n  error: ${err instanceof Error ? err.message : String(err)}\n`));
      }
    } finally {
      activeAbort = null;
      interruptRequested = false;
    }
  }

  function handleMode(arg: string): void {
    const [m, perm] = arg.split(/\s+/);
    if (m === 'chat' || m === 'cowork' || m === 'code' || m === 'dvalin') {
      mode = m;
      if (m === 'code') {
        codePermissionMode = (['ask', 'plan', 'auto', 'bypass'].includes(perm) ? perm : 'auto') as CodePermissionMode;
      }
      process.stdout.write(chalk.dim(`  mode → ${mode}${mode === 'code' ? ` (${codePermissionMode})` : ''}\n`));
    } else {
      process.stdout.write(chalk.red('  unknown mode — use: chat | cowork | code | dvalin\n'));
    }
  }

  /** Returns true if handled locally; false to forward to the agent (e.g. /git). */
  function handleLocal(line: string): boolean {
    if (isExitCommand(line)) {
      shutdown();
      return true;
    }
    if (!line.startsWith('/')) return false;
    const sp = line.indexOf(' ');
    const cmd = sp === -1 ? line.slice(1) : line.slice(1, sp);
    const arg = sp === -1 ? '' : line.slice(sp + 1).trim();
    switch (cmd) {
      case 'exit':
      case 'quit':
        shutdown();
        return true;
      case 'clear':
        sessionId = undefined;
        process.stdout.write(chalk.dim('  ✓ new session\n'));
        return true;
      case 'mode':
        handleMode(arg);
        return true;
      case 'help':
        process.stdout.write(R.helpText() + '\n');
        return true;
      default:
        return false; // /git /plan /compact /undo → handled by the agent loop
    }
  }

  // Main REPL loop.
  // eslint-disable-next-line no-constant-condition
  while (!exiting) {
    process.stdout.write('\n' + R.statusLine(mode, providerModel, cwdDisplay) + '\n');
    const answer = await ask(chalk.cyan('› '));
    if (answer === null) break;
    const line = answer.trim();
    if (!line) continue;
    if (handleLocal(line)) continue;
    await runTurn(line);
  }
}

/** First-run: if no API key is available (and the provider needs one), walk the
 * user through a minimal provider setup and persist it to config. */
async function ensureConfigured(
  rl: readline.Interface,
  ask: AskLine,
): Promise<boolean> {
  const cfg = await readConfig();
  const preset = findPreset(cfg.llm.provider);
  const needsKey = preset?.needsKey ?? true;
  if (cfg.llm.apiKey || !needsKey) return true;

  process.stdout.write(chalk.bold("\n  No LLM provider configured. Let's set one up.\n\n"));
  process.stdout.write('  Providers: ' + PROVIDER_PRESETS.map(p => p.id).join(', ') + '\n');

  const providerAnswer = await ask('  Provider [deepseek]: ');
  if (providerAnswer === null) return false;
  const providerId = providerAnswer.trim() || 'deepseek';
  const chosen = findPreset(providerId) ?? findPreset('deepseek')!;

  let apiKey = '';
  if (chosen.needsKey) {
    const apiKeyAnswer = await askMasked(rl, '  API key: ');
    if (apiKeyAnswer === null) return false;
    apiKey = apiKeyAnswer.trim();
  }
  const modelAnswer = await ask(`  Model [${chosen.defaultModel}]: `);
  if (modelAnswer === null) return false;
  const model = modelAnswer.trim() || chosen.defaultModel;

  await writeConfig({
    llm: { provider: chosen.id, apiKey: apiKey || undefined, baseUrl: chosen.baseUrl, model },
  });
  process.stdout.write(chalk.dim('  ✓ saved to ~/.dvalincode/config.json\n'));
  return true;
}

/** Ask without echoing the typed characters (for API keys). */
function askMasked(rl: readline.Interface, query: string): Promise<string | null> {
  return new Promise(resolve => {
    const iface = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = iface._writeToOutput;
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      iface._writeToOutput = original;
      process.stdout.write('\n');
      resolve(answer);
    };
    const onClose = () => finish(null);
    rl.once('close', onClose);
    try {
      rl.question(query, answer => finish(answer));
    } catch {
      finish(null);
    }
    // After the query is printed, suppress echo of subsequent keystrokes.
    iface._writeToOutput = () => {};
  });
}

function askLine(
  rl: readline.Interface,
  query: string,
  isClosed: () => boolean,
  signal?: AbortSignal,
): Promise<string | null> {
  if (isClosed()) return Promise.resolve(null);
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) return;
      settled = true;
      rl.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const onClose = () => finish(null);
    const onAbort = () => finish(null);
    rl.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      rl.question(query, answer => finish(answer));
    } catch {
      finish(null);
    }
  });
}

export function isExitCommand(line: string): boolean {
  const value = line.trim().toLowerCase();
  return value === 'exit' || value === 'quit' || value === ':q' || value === '/exit' || value === '/quit';
}
