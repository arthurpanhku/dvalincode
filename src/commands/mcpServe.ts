import path from 'node:path';
import type { Command } from 'commander';

import { runMcpStdio } from '../mcp/server.js';
import type { UnattendedPermissionMode } from '../core/policy.js';

type McpServeOptions = {
  maxPermissionMode?: string;
  workspace?: string[];
};

export function registerMcpServeCommand(program: Command): void {
  program
    .command('mcp-serve')
    .description('Serve task-level governed DvalinCode tools over stdio MCP')
    .option('--max-permission-mode <mode>', 'permission ceiling: plan | auto | bypass (default: auto)')
    .option('--workspace <dir>', 'allowed workspace root (repeatable)', collect, [])
    .action(async (options: McpServeOptions) => {
      const ceiling = options.maxPermissionMode ?? 'auto';
      if (!['plan', 'auto', 'bypass'].includes(ceiling)) {
        console.error(`dvalincode mcp-serve: unknown permission ceiling: ${ceiling}`);
        process.exitCode = 2;
        return;
      }
      const cwd = process.cwd();
      const workspaces = options.workspace?.length
        ? options.workspace.map(workspace => path.resolve(workspace))
        : [cwd];
      try {
        await runMcpStdio({
          cwd,
          workspaces,
          maxPermissionMode: ceiling as UnattendedPermissionMode,
        });
      } catch (err) {
        console.error(`dvalincode mcp-serve: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
