import { Command, CommanderError } from 'commander';
import { registerSecuritySubcommands } from './commands/security.js';
import { registerMcpServeCommand } from './commands/mcpServe.js';
import { registerMcpInstallCommand } from './commands/mcpInstall.js';
import { EXIT } from './core/exitCodes.js';
import { VERSION } from './version.js';

export function buildDvalinProgram(): Command {
  const program = new Command()
    .name('dvalin')
    .description('Discover, remediate, and independently verify security findings')
    .version(VERSION);
  registerSecuritySubcommands(program);
  registerMcpServeCommand(program);
  registerMcpInstallCommand(program);
  return program;
}

export async function runDvalinCli(argv: string[]): Promise<void> {
  const program = buildDvalinProgram();
  applyExitOverride(program);
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? EXIT.ok : EXIT.usageError;
      return;
    }
    throw error;
  }
}

function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const child of command.commands) applyExitOverride(child);
}
