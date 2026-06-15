import type { Command } from 'commander';
import type { AgentMode } from '../agent/modes.js';

export function registerTuiCommand(program: Command): void {
  program
    .command('tui')
    .description('Launch the interactive terminal coding agent (default when run bare in a TTY)')
    .option('--mode <mode>', 'starting mode: chat | cowork | code', 'chat')
    .option('--cwd <path>', 'workspace directory (defaults to the current directory)')
    .action(async (options: { mode?: string; cwd?: string }) => {
      const { runTui } = await import('../tui/app.js');
      const mode = (['chat', 'cowork', 'code'].includes(options.mode ?? '') ? options.mode : 'chat') as AgentMode;
      await runTui({ mode, cwd: options.cwd });
    });
}
