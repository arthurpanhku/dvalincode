import { z } from 'zod';
import type { Command } from 'commander';
import { createDvalinContext } from '../core/context.js';
import { loadPolicy, PolicyViolationError } from '../core/policy.js';
import type { ToolRegistry } from '../tools/registry.js';
import { renderToolResult } from '../ui/output.js';

/**
 * Machine-readable failure kinds. Every one is decided structurally — from a
 * typed error or from the registry's own metadata — never by matching an error
 * message, so a reworded message cannot silently reclassify a failure.
 */
export type RunToolErrorCode =
  | 'invalid_input'
  | 'unknown_tool'
  | 'permission_denied'
  | 'policy_denied'
  | 'invalid_tool_input'
  | 'tool_error';

export type RunToolJsonResult =
  | { ok: true; tool: string; title: string; output: string; metadata?: Record<string, unknown> }
  | { ok: false; tool: string; error: { code: RunToolErrorCode; message: string } };

export function registerRunToolCommand(program: Command, registry: ToolRegistry): void {
  program
    .command('run-tool')
    .description('Run a registered tool with JSON input')
    .argument('<name>', 'tool name')
    .requiredOption('-i, --input <json>', 'tool input as JSON')
    .option('-y, --yes', 'allow tools that execute processes or modify files', false)
    .option('--json', 'print the result as JSON, including structured errors')
    .action(async (name: string, options: { input: string; yes: boolean; json?: boolean }) => {
      const emit = (result: RunToolJsonResult): void => {
        if (options.json) console.log(JSON.stringify(result, null, 2));
        else if (result.ok) console.log(renderToolResult(result));
        else console.error(`dvalincode: ${result.error.message}`);
        if (!result.ok) process.exitCode = 1;
      };

      // Without --json the historic behaviour is kept exactly: throw, and let
      // the top-level handler print to stderr and exit 1. The original error
      // is rethrown rather than a copy — PolicyViolationError is what proves
      // enforcement to callers and to the #45 regression tests, and wrapping
      // it in a plain Error would quietly discard that.
      const fail = (code: RunToolErrorCode, message: string, original?: unknown): void => {
        if (!options.json) throw original ?? new Error(message);
        emit({ ok: false, tool: name, error: { code, message } });
      };

      let input: unknown;
      try {
        input = JSON.parse(options.input);
      } catch (error) {
        const message = `Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`;
        fail('invalid_input', message);
        return;
      }

      // Org policy applies to every entrypoint, including this one (#45).
      // Mirrors runAgentTurn: malformed sources are skipped loudly, never
      // silently treated as "allow everything". Warnings go to stderr, so
      // --json keeps stdout parseable.
      const loadedPolicy = loadPolicy(process.cwd());
      for (const source of loadedPolicy.sources) {
        if (source.error) {
          console.warn(`⚠ Ignored malformed policy at ${source.path}: ${source.error}`);
        }
      }

      const tool = registry.get(name);
      if (!tool) {
        fail('unknown_tool', `Unknown tool: ${name}`);
        return;
      }

      const context = createDvalinContext({
        cwd: process.cwd(),
        allowExecute: options.yes,
        allowWrite: options.yes,
        policy: loadedPolicy.policy,
      });

      try {
        const result = await registry.run(name, input, context);
        emit({ ok: true, tool: name, title: result.title, output: result.output, ...(result.metadata ? { metadata: result.metadata } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail(classify(error, tool.access, options.yes), message, error);
      }
    });
}

/**
 * `registry.run` throws plain Errors for a missing --yes, so permission is
 * recognised from the tool's declared access and the flag rather than from the
 * message. The other kinds carry their own types.
 */
function classify(error: unknown, access: string, allowed: boolean): RunToolErrorCode {
  if (error instanceof PolicyViolationError) return 'policy_denied';
  if (error instanceof z.ZodError) return 'invalid_tool_input';
  if (!allowed && (access === 'write' || access === 'execute')) return 'permission_denied';
  return 'tool_error';
}
