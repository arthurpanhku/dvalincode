import type { Command } from 'commander';
import { startServer } from '../server/index.js';

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the web server + GUI (for server deployment or browser use)')
    .option('--port <port>', 'port to listen on (default: $PORT or 3000)', (v) => parseInt(v, 10))
    .option('--host <host>', 'host to bind — use 0.0.0.0 to expose on a network')
    .option('--open', 'open the browser on start')
    .option('--no-open', 'do not open the browser on start')
    .action(async (options: { port?: number; host?: string; open?: boolean }, command: Command) => {
      // Tri-state: honor an explicit --open/--no-open, otherwise default to
      // opening only in an interactive terminal (skip it on headless servers).
      const explicit = command.getOptionValueSource('open') === 'cli';
      const open = explicit ? options.open : Boolean(process.stdout.isTTY);
      await startServer({ port: options.port, host: options.host, open });
    });
}
