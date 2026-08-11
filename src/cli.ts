import { Command, CommanderError } from 'commander';
import { EXIT } from './core/exitCodes.js';
import { VERSION } from './version.js';
import { registerAskCommand } from './commands/ask.js';
import { registerChatCommand } from './commands/chat.js';
import { registerInitCommand } from './commands/init.js';
import { registerMemoryCommand } from './commands/memory.js';
import { registerRunToolCommand } from './commands/runTool.js';
import { registerScanCommand } from './commands/scan.js';
import { registerToolsCommand } from './commands/tools.js';
import { registerReportCommand } from './commands/report.js';
import { registerTrustCommand } from './commands/trust.js';
import { registerPolicyCommand } from './commands/policy.js';
import { registerEvidenceCommand } from './commands/evidence.js';
import { registerServeCommand } from './commands/serve.js';
import { registerTuiCommand } from './commands/tui.js';
import { registerDataCommands } from './commands/data.js';
import { registerProviderCommand } from './commands/provider.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerDvalinCommand } from './commands/dvalin.js';
import { registerRunCommand } from './commands/run.js';
import { registerMcpServeCommand } from './commands/mcpServe.js';
import { registerSecurityCommand } from './commands/security.js';
import { createDefaultToolRegistry } from './tools/registry.js';

export function buildProgram(): Command {
  const program = new Command();
  const registry = createDefaultToolRegistry();

  program
    .name('dvalincode')
    .description('Local-first coding agent — terminal UI by default, `serve` for the web GUI')
    .version(VERSION);

  registerScanCommand(program);
  registerDvalinCommand(program);
  registerSecurityCommand(program);
  registerToolsCommand(program, registry);
  registerRunToolCommand(program, registry);
  registerAskCommand(program, registry);
  registerChatCommand(program, registry);
  registerInitCommand(program);
  registerMemoryCommand(program);
  registerReportCommand(program);
  registerTrustCommand(program);
  registerPolicyCommand(program);
  registerEvidenceCommand(program);
  registerServeCommand(program);
  registerTuiCommand(program);
  registerDataCommands(program);
  registerProviderCommand(program);
  registerUpdateCommand(program);
  registerRunCommand(program);
  registerMcpServeCommand(program);

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
  const program = buildProgram();
  applyExitOverride(program);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander uses exit 1 for parse errors by default. Harness consumers
      // need every bad flag/missing option argument to map to usage exit 2.
      process.exitCode = err.exitCode === 0 ? EXIT.ok : EXIT.usageError;
      return;
    }
    throw err;
  }
}

function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) applyExitOverride(child);
}
