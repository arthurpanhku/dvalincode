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

/** Launch the interactive terminal agent. Drives the same `runAgentTurn` the
 * web GUI uses, with stdout streaming and stdin approval. */
export async function runTui(opts: TuiOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  let mode: AgentMode = opts.mode ?? 'chat';
  let codePermissionMode: CodePermissionMode = 'ask';
  let sessionId: string | undefined;
  let activeAbort: AbortController | null = null;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (query: string): Promise<string> => new Promise(resolve => rl.question(query, resolve));

  process.stdout.write(R.banner());

  await ensureConfigured(rl, ask);

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
      activeAbort.abort();
    } else {
      process.stdout.write('\n');
      rl.close();
    }
  });
  rl.on('close', () => process.exit(0));

  // Approval gate for Cowork / Code-Ask writes and commands.
  const requestApproval = async (_id: string, toolName: string, input: unknown): Promise<boolean> => {
    const answer = await ask('\n' + R.approvalLine(toolName, input));
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
        { content, sessionId, cwd, mode, codePermissionMode, signal: abort.signal },
        { onEvent, requestApproval },
      );
      sessionId = turn.sessionId;
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
    }
  }

  function handleMode(arg: string): void {
    const [m, perm] = arg.split(/\s+/);
    if (m === 'chat' || m === 'cowork' || m === 'code') {
      mode = m;
      if (m === 'code') {
        codePermissionMode = (['ask', 'plan', 'auto', 'bypass'].includes(perm) ? perm : 'auto') as CodePermissionMode;
      }
      process.stdout.write(chalk.dim(`  mode → ${mode}${mode === 'code' ? ` (${codePermissionMode})` : ''}\n`));
    } else {
      process.stdout.write(chalk.red('  unknown mode — use: chat | cowork | code\n'));
    }
  }

  /** Returns true if handled locally; false to forward to the agent (e.g. /git). */
  function handleLocal(line: string): boolean {
    if (!line.startsWith('/')) return false;
    const sp = line.indexOf(' ');
    const cmd = sp === -1 ? line.slice(1) : line.slice(1, sp);
    const arg = sp === -1 ? '' : line.slice(sp + 1).trim();
    switch (cmd) {
      case 'exit':
      case 'quit':
        rl.close();
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
  while (true) {
    process.stdout.write('\n' + R.statusLine(mode, providerModel, cwdDisplay) + '\n');
    const line = (await ask(chalk.cyan('› '))).trim();
    if (!line) continue;
    if (handleLocal(line)) continue;
    await runTurn(line);
  }
}

/** First-run: if no API key is available (and the provider needs one), walk the
 * user through a minimal provider setup and persist it to config. */
async function ensureConfigured(
  rl: readline.Interface,
  ask: (q: string) => Promise<string>,
): Promise<void> {
  const cfg = await readConfig();
  const preset = findPreset(cfg.llm.provider);
  const needsKey = preset?.needsKey ?? true;
  if (cfg.llm.apiKey || !needsKey) return;

  process.stdout.write(chalk.bold("\n  No LLM provider configured. Let's set one up.\n\n"));
  process.stdout.write('  Providers: ' + PROVIDER_PRESETS.map(p => p.id).join(', ') + '\n');

  const providerId = (await ask('  Provider [deepseek]: ')).trim() || 'deepseek';
  const chosen = findPreset(providerId) ?? findPreset('deepseek')!;

  let apiKey = '';
  if (chosen.needsKey) {
    apiKey = (await askMasked(rl, '  API key: ')).trim();
  }
  const model = (await ask(`  Model [${chosen.defaultModel}]: `)).trim() || chosen.defaultModel;

  await writeConfig({
    llm: { provider: chosen.id, apiKey: apiKey || undefined, baseUrl: chosen.baseUrl, model },
  });
  process.stdout.write(chalk.dim('  ✓ saved to ~/.dvalincode/config.json\n'));
}

/** Ask without echoing the typed characters (for API keys). */
function askMasked(rl: readline.Interface, query: string): Promise<string> {
  return new Promise(resolve => {
    const iface = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = iface._writeToOutput;
    rl.question(query, answer => {
      iface._writeToOutput = original;
      process.stdout.write('\n');
      resolve(answer);
    });
    // After the query is printed, suppress echo of subsequent keystrokes.
    iface._writeToOutput = () => {};
  });
}
