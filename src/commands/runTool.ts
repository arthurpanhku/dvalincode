import type { Command } from 'commander';
import { createDvalinContext } from '../core/context.js';
import { loadPolicy } from '../core/policy.js';
import type { ToolRegistry } from '../tools/registry.js';
import { renderToolResult } from '../ui/output.js';

export function registerRunToolCommand(program: Command, registry: ToolRegistry): void {
  program
    .command('run-tool')
    .description('Run a registered tool with JSON input')
    .argument('<name>', 'tool name')
    .requiredOption('-i, --input <json>', 'tool input as JSON')
    .option('-y, --yes', 'allow tools that execute processes or modify files', false)
    .action(async (name: string, options: { input: string; yes: boolean }) => {
      const input = parseJson(options.input);
      // Org policy applies to every entrypoint, including this one (#45).
      // Mirrors runAgentTurn: malformed sources are skipped loudly, never
      // silently treated as "allow everything".
      const loadedPolicy = loadPolicy(process.cwd());
      for (const source of loadedPolicy.sources) {
        if (source.error) {
          console.warn(`⚠ Ignored malformed policy at ${source.path}: ${source.error}`);
        }
      }
      const context = createDvalinContext({
        cwd: process.cwd(),
        allowExecute: options.yes,
        allowWrite: options.yes,
        policy: loadedPolicy.policy,
      });
      const result = await registry.run(name, input, context);
      console.log(renderToolResult(result));
    });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON input: ${message}`);
  }
}

