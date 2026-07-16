import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import path from 'node:path';
import type { Command } from 'commander';

import type { AgentEvent } from '../agent/types.js';
import type { AgentMode, CodePermissionMode } from '../agent/modes.js';
import {
  executeHarnessRun,
  HarnessUsageError,
  type HarnessRunExecution,
  type HarnessRunResult,
} from '../harness/run.js';

type OutputFormat = 'text' | 'json' | 'stream-json';

export type RunCommandOptions = {
  session?: string;
  cwd?: string;
  mode?: string;
  permissionMode?: string;
  provider?: string;
  model?: string;
  profile?: string;
  outputFormat?: string;
  includeDeltas?: boolean;
  maxIterations?: string;
  maxToolCalls?: string;
  timeout?: string;
  report?: string;
  quiet?: boolean;
  unattended?: boolean;
  promptFile?: string;
};

export type RunCommandIO = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stderr: Writable;
};

export function registerRunCommand(program: Command): void {
  const command = program
    .command('run')
    .description('Run one governed agent turn non-interactively')
    .argument('[prompt...]', 'prompt text, or "-" to read it from stdin')
    .option('--prompt-file <file>', 'read the prompt from a file')
    .option('--session <id>', 'resume an existing session')
    .option('--cwd <dir>', 'workspace root (default: current directory)')
    .option('--mode <mode>', 'agent mode: chat | cowork | code (default: code)')
    .option('--permission-mode <mode>', 'code permission mode: plan | auto | bypass (default: auto)')
    .option('--provider <name>', 'provider name')
    .option('--model <name>', 'model name')
    .option('--profile <name>', 'named provider profile')
    .option('--output-format <format>', 'text | json | stream-json (default: text)')
    .option('--include-deltas', 'include token_delta events in stream-json output')
    .option('--max-iterations <n>', 'maximum model/tool iterations (default: 40)')
    .option('--max-tool-calls <n>', 'maximum tool calls for the turn')
    .option('--timeout <minutes>', 'wall-clock timeout in minutes (default: 25)')
    .option('--report <file>', 'write the Markdown run report to a file')
    .option('--quiet', 'suppress stderr progress lines')
    .option('--unattended', 'apply unattended policy limits even when stdin is a TTY')
    .addHelpText(
      'after',
      '\nExit codes:\n  0  completed\n  1  agent/tool/provider error\n  2  usage error\n  3  policy violation\n  4  timeout or interrupt',
    )
    .action(async (prompt: string[], options: RunCommandOptions) => {
      const code = await runCommand(prompt, options, {
        stdin: process.stdin,
        stdout: process.stdout,
        stderr: process.stderr,
      });
      process.exitCode = code;
    });

  // Keep a named reference so Commander includes command-specific help in
  // generated output even though the action is async.
  void command;
}

export async function runCommand(
  promptParts: string[],
  options: RunCommandOptions,
  io: RunCommandIO,
  execute: typeof executeHarnessRun = executeHarnessRun,
): Promise<number> {
  const startedAt = Date.now();
  const outputFormat = (options.outputFormat ?? 'text') as OutputFormat;
  let resultWritten = false;
  const writeJsonLine = (value: unknown): void => {
    io.stdout.write(JSON.stringify(value) + '\n');
  };

  try {
    if (!['text', 'json', 'stream-json'].includes(outputFormat)) {
      throw new HarnessUsageError(`Unknown output format: ${outputFormat}`);
    }
    const mode = (options.mode ?? 'code') as AgentMode;
    if (!['chat', 'cowork', 'code'].includes(mode)) throw new HarnessUsageError(`Unknown agent mode: ${mode}`);
    const permissionMode = (options.permissionMode ?? undefined) as CodePermissionMode | undefined;
    if (permissionMode && !['ask', 'plan', 'auto', 'bypass'].includes(permissionMode)) {
      throw new HarnessUsageError(`Unknown permission mode: ${permissionMode}`);
    }
    if (permissionMode === 'ask') {
      throw new HarnessUsageError('Permission mode "ask" is interactive and cannot be used with a headless run.');
    }

    const content = await resolvePrompt(promptParts, options.promptFile, io.stdin);
    const maxIterations = parseOptionalNumber(options.maxIterations, 'max iterations', true);
    const maxToolCalls = parseOptionalNumber(options.maxToolCalls, 'max tool calls', true);
    const timeoutMinutes = parseOptionalNumber(options.timeout, 'timeout', false);
    const elapsed = () => `${Math.round((Date.now() - startedAt) / 1000)}s`;
    let progressToolCalls = 0;

    const progress = (line: string): void => {
      if (!options.quiet) io.stderr.write(line + '\n');
    };
    const emitEvent = (event: AgentEvent): void => {
      if (outputFormat === 'stream-json') {
        if (event.type === 'token_delta' && !options.includeDeltas) return;
        writeJsonLine(event.type === 'tool_result' ? truncateToolResult(event) : event);
        return;
      }
      if (event.type === 'tool_call') {
        progressToolCalls++;
        progress(`[${elapsed()}] tool#${progressToolCalls} ${event.name} ${truncate(JSON.stringify(event.input ?? {}), 160)}`);
      } else if (event.type === 'tool_error') {
        progress(`[${elapsed()}] tool-error ${event.name}: ${truncate(event.error, 160)}`);
      } else if (event.type === 'llm_iteration') {
        progress(`[${elapsed()}] iteration ${event.iteration}`);
      }
    };

    const interrupt = new AbortController();
    const onSigint = () => interrupt.abort(new Error('interrupted'));
    process.once('SIGINT', onSigint);
    let execution: HarnessRunExecution;
    try {
      execution = await execute(
        {
          content,
          cwd: path.resolve(options.cwd ?? process.cwd()),
          sessionId: options.session,
          mode,
          permissionMode,
          provider: options.provider,
          model: options.model,
          profile: options.profile,
          maxIterations,
          maxToolCalls,
          timeoutMinutes,
          reportFile: options.report,
          unattended: !!options.unattended || !io.stdin.isTTY,
          origin: 'cli',
          signal: interrupt.signal,
        },
        {
          onProviderSelected: (provider, modelName) => progress(`provider: ${provider} · model: ${modelName}`),
          onRunStart: event => {
            if (outputFormat === 'stream-json') writeJsonLine(event);
          },
          onEvent: emitEvent,
        },
      );
    } finally {
      process.removeListener('SIGINT', onSigint);
    }

    if (outputFormat === 'text') {
      writeTextResult(execution, io);
    } else if (outputFormat === 'json') {
      writeJsonLine(execution.result);
      resultWritten = true;
    } else {
      writeJsonLine({ type: 'result', ...execution.result });
      resultWritten = true;
    }

    if (execution.exitCode === 0) {
      progress(
        `done in ${elapsed()}: iterations=${execution.result.iterationsUsed} toolCalls=${execution.result.toolCalls} runId=${execution.result.runId ?? 'n/a'}`,
      );
    } else if (outputFormat === 'text') {
      io.stderr.write(`dvalincode run: ${execution.result.error ?? 'run failed'}\n`);
    }
    return execution.exitCode;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const result: HarnessRunResult = {
      ok: false,
      iterationsUsed: 0,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      wallSeconds: (Date.now() - startedAt) / 1000,
      output: '',
      stopReason: 'error',
      error,
    };
    if (outputFormat === 'json' && !resultWritten) writeJsonLine(result);
    else if (outputFormat === 'stream-json' && !resultWritten) writeJsonLine({ type: 'result', ...result });
    else io.stderr.write(`dvalincode run: ${error}\n`);
    return 2;
  }
}

async function resolvePrompt(
  promptParts: string[],
  promptFile: string | undefined,
  stdin: Readable & { isTTY?: boolean },
): Promise<string> {
  if (promptFile && promptParts.length > 0) {
    throw new HarnessUsageError('Use exactly one prompt source: argv, stdin "-", or --prompt-file.');
  }
  if (promptFile) {
    try {
      const content = await readFile(path.resolve(promptFile), 'utf8');
      if (!content.trim()) throw new HarnessUsageError('Prompt file is empty.');
      return content;
    } catch (err) {
      if (err instanceof HarnessUsageError) throw err;
      throw new HarnessUsageError(`Cannot read prompt file ${promptFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (promptParts.length === 1 && promptParts[0] === '-') {
    if (stdin.isTTY) throw new HarnessUsageError('The "-" prompt source requires piped stdin.');
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    const content = Buffer.concat(chunks).toString('utf8');
    if (!content.trim()) throw new HarnessUsageError('Prompt from stdin is empty.');
    return content;
  }
  if (promptParts.includes('-')) {
    throw new HarnessUsageError('Use "-" by itself to read the prompt from stdin.');
  }
  if (promptParts.length === 0) {
    throw new HarnessUsageError('No prompt provided. Use argv, "-", or --prompt-file.');
  }
  const content = promptParts.join(' ');
  if (!content.trim()) throw new HarnessUsageError('Prompt must not be empty.');
  return content;
}

function parseOptionalNumber(raw: string | undefined, label: string, integer: boolean): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new HarnessUsageError(`${label} must be a positive ${integer ? 'integer' : 'number'}.`);
  }
  return value;
}

function truncateToolResult(event: Extract<AgentEvent, { type: 'tool_result' }>): AgentEvent & { truncated?: true } {
  if (Buffer.byteLength(event.output, 'utf8') <= 4096) return event;
  return {
    ...event,
    output: Buffer.from(event.output, 'utf8').subarray(0, 4096).toString('utf8'),
    truncated: true,
  };
}

function truncate(value: string, length: number): string {
  return value.length > length ? value.slice(0, length) + '…' : value;
}

function writeTextResult(execution: HarnessRunExecution, io: RunCommandIO): void {
  const result = execution.result;
  if (!result.ok) return;
  io.stdout.write(result.output + '\n\n');
  io.stdout.write(
    `--- Session: ${result.sessionId ?? 'n/a'} | ${result.iterationsUsed > 1 ? `(${result.iterationsUsed} iterations) ` : ''}Model: ${result.provider ?? 'unknown'}/${result.model ?? 'unknown'} ---\n`,
  );
  if (result.runId) io.stdout.write(`🔒 Audit: run ${result.runId} — \`dvalincode report --last\`\n`);
}
