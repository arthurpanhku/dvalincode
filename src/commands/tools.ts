import type { Command } from 'commander';
import { toolParametersSchema, type ToolRegistry } from '../tools/registry.js';

/** One tool as `dvalincode tools --json` reports it. */
export type ToolListEntry = {
  name: string;
  access: string;
  description: string;
  /** JSON Schema for `run-tool -i`. The same schema the model is given. */
  parameters: Record<string, unknown>;
  /** True when the tool needs `run-tool --yes` to run at all. */
  requiresYes: boolean;
};

export function registerToolsCommand(program: Command, registry: ToolRegistry): void {
  program
    .command('tools')
    .description('List available tools')
    .option('--json', 'print the tool list as JSON, including each input schema')
    .action((options: { json?: boolean }) => {
      const tools = registry.list();
      if (options.json) {
        console.log(JSON.stringify({ tools: tools.map(toEntry) }, null, 2));
        return;
      }
      // Width from the longest name rather than a fixed 14: `list_remediation_cases`
      // overflowed it and pushed the rest of that row out of alignment, which
      // silently breaks anything parsing these columns by position.
      const nameWidth = Math.max(...tools.map(tool => tool.name.length), 4);
      const accessWidth = Math.max(...tools.map(tool => tool.access.length), 6);
      for (const tool of tools) {
        console.log(`${tool.name.padEnd(nameWidth)}  ${tool.access.padEnd(accessWidth)}  ${tool.description}`);
      }
    });
}

function toEntry(tool: ReturnType<ToolRegistry['list']>[number]): ToolListEntry {
  return {
    name: tool.name,
    access: tool.access,
    description: tool.description,
    parameters: toolParametersSchema(tool),
    requiresYes: tool.access === 'write' || tool.access === 'execute',
  };
}
