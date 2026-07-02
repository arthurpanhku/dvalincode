import { Command } from 'commander';
import { registerAskCommand } from './commands/ask.js';
import { registerChatCommand } from './commands/chat.js';
import { registerInitCommand } from './commands/init.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerRunToolCommand } from './commands/runTool.js';
import { registerScanCommand } from './commands/scan.js';
import { registerToolsCommand } from './commands/tools.js';
import { registerReportCommand } from './commands/report.js';
import { registerTrustCommand } from './commands/trust.js';
import { registerEvidenceCommand } from './commands/evidence.js';
import { registerServeCommand } from './commands/serve.js';
import { registerTuiCommand } from './commands/tui.js';
import { registerDataCommands } from './commands/data.js';
import { createDefaultToolRegistry } from './tools/registry.js';

export function buildProgram(): Command {
  const program = new Command();
  const registry = createDefaultToolRegistry();

  program
    .name('dvalincode')
    .description('Local-first coding agent — terminal UI by default, `serve` for the web GUI')
    .version('0.9.0');

  registerScanCommand(program);
  registerToolsCommand(program, registry);
  registerRunToolCommand(program, registry);
  registerAskCommand(program, registry);
  registerChatCommand(program, registry);
  registerInitCommand(program);
  registerMemoryCommand(program);
  registerReportCommand(program);
  registerTrustCommand(program);
  registerEvidenceCommand(program);
  registerServeCommand(program);
  registerTuiCommand(program);
  registerDataCommands(program);

  // Bare invocation: launch the terminal agent in an interactive TTY,
  // otherwise fall back to help (e.g. piped or non-interactive contexts).
  program.action(async () => {
    if (process.stdin.isTTY) {
      const { runTui } = await import('./tui/app.js');
      await runTui();
    } else {
      program.help();
    }
  });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
