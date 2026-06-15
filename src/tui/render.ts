import chalk from 'chalk';
import type { AgentMode } from '../agent/modes.js';

/** Pure terminal formatters for the TUI. No IO — returns strings so they can be
 * unit-tested. chalk auto-disables color when stdout is not a TTY. */

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

/** A short one-line summary of a tool's arguments for call/approval lines. */
export function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const key = ['filePath', 'path', 'command', 'pattern', 'query', 'glob'].find(
      k => k in o && typeof o[k] === 'string',
    );
    if (key) return clip(String(o[key]), 80);
    return clip(JSON.stringify(o), 80);
  }
  return clip(String(input ?? ''), 80);
}

export function formatToolCall(name: string, input: unknown): string {
  return chalk.cyan(`  ⚙ ${name}`) + chalk.dim(`  ${summarizeToolInput(input)}`);
}

export function formatToolError(name: string, error: string): string {
  return chalk.red(`  ✗ ${name}: ${clip(error, 200)}`);
}

/** Colorize a `+ `/`- `/`  ` diff (as produced by edit_file / write_file output). */
export function colorizeDiff(text: string): string {
  return text
    .split('\n')
    .map(line => {
      if (line.startsWith('+ ')) return chalk.green(line);
      if (line.startsWith('- ')) return chalk.red(line);
      return chalk.dim(line);
    })
    .join('\n');
}

/** Render a tool result for the terminal: indented and diff-colorized. */
export function formatToolResult(output: string): string {
  if (!output.trim()) return chalk.dim('  ✓ done');
  return colorizeDiff(output)
    .split('\n')
    .map(l => '  ' + l)
    .join('\n');
}

const MODE_COLOR: Record<AgentMode, (s: string) => string> = {
  chat: chalk.blue,
  cowork: chalk.magenta,
  code: chalk.yellow,
};

/** The dim context line printed above the input prompt. */
export function statusLine(mode: AgentMode, providerModel: string, cwdDisplay: string): string {
  const tag = MODE_COLOR[mode](`[${mode}]`);
  return `${tag} ${chalk.dim(providerModel)} ${chalk.dim('·')} ${chalk.dim(cwdDisplay)}`;
}

export function approvalLine(toolName: string, input: unknown): string {
  return (
    chalk.yellow('  ⚠ approve ') +
    chalk.bold(toolName) +
    chalk.dim(`  ${summarizeToolInput(input)}`) +
    chalk.yellow('  [y/N] ')
  );
}

export function banner(): string {
  return [
    '',
    chalk.bold.cyan('  DvalinCode') + chalk.dim('  — local-first terminal coding agent'),
    chalk.dim('  /help for commands · /mode to switch · Ctrl-C to interrupt · /exit to quit'),
    '',
  ].join('\n');
}

export function helpText(): string {
  return [
    chalk.bold('  Commands'),
    '  /mode <chat|cowork|code> [perm]  switch mode (perm: ask|plan|auto|bypass for code)',
    '  /clear                           start a fresh session',
    '  /git  /plan <task>  /compact  /undo [N]   (handled by the agent)',
    '  /help                            show this help',
    '  /exit                            quit',
    '',
    chalk.dim('  @path references inline a file · Ctrl-C interrupts a running turn'),
  ].join('\n');
}
