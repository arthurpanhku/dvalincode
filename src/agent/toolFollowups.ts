import path from 'node:path';
import type { DvalinContext } from '../core/context.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolResult } from '../tools/types.js';
import type { CheckDiagnostic } from '../tools/checkDiagnostics.js';

type FollowupConfig = { before?: string; after?: string; diagnostics: Array<'lint' | 'typecheck'> };

/** Operator environment only. Repository files never enable automatic execution. */
export function toolFollowupConfig(env: NodeJS.ProcessEnv = process.env): FollowupConfig {
  const diagnostics: FollowupConfig['diagnostics'] = [];
  for (const kind of ['lint', 'typecheck'] as const) {
    if (env.DVALINCODE_EDIT_DIAGNOSTICS?.split(',').map(item => item.trim()).includes(kind)) diagnostics.push(kind);
  }
  return { before: env.DVALINCODE_PRE_TOOL_COMMAND?.trim(), after: env.DVALINCODE_POST_TOOL_COMMAND?.trim(), diagnostics };
}

export async function runToolHook(
  stage: 'before' | 'after',
  command: string,
  name: string,
  registry: ToolRegistry,
  context: DvalinContext,
): Promise<string | undefined> {
  const result = await registry.run('run_check', { kind: 'custom', command, timeoutMs: 10_000 }, context);
  const exitCode = typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : null;
  context.audit?.append({ type: 'tool_hook', stage, tool: name, exitCode });
  if (exitCode !== 0) return `${stage === 'before' ? 'Pre-tool' : 'Post-tool'} hook exited with ${exitCode ?? 'no status'}.`;
}

export async function editedFileDiagnostics(
  result: ToolResult,
  kinds: FollowupConfig['diagnostics'],
  registry: ToolRegistry,
  context: DvalinContext,
  reserve: () => boolean,
): Promise<string[]> {
  const edited = typeof result.metadata?.path === 'string' ? [result.metadata.path] :
    Array.isArray(result.metadata?.files) ? result.metadata.files.map(file => file.filePath as string) : [];
  if (!edited.length) return [];
  const editedPaths = new Set(edited.map(file => path.relative(context.cwd, path.resolve(context.cwd, file)).split(path.sep).join('/')));
  const output: string[] = [];
  for (const kind of kinds) {
    if (context.signal?.aborted) break;
    if (!reserve()) {
      output.push('No tool-call budget remains for edit diagnostics.');
      break;
    }
    try {
      const checked = await registry.run('run_check', { kind, timeoutMs: 15_000 }, context);
      const diagnostics = (checked.metadata?.diagnostics ?? []) as CheckDiagnostic[];
      const matches = diagnostics.filter(item => editedPaths.has(item.file));
      for (const item of matches) output.push(`${item.file}:${item.line}${item.column ? `:${item.column}` : ''} ${item.message}`);
      if (!matches.length) {
        const status = checked.metadata?.skipped ? 'check unavailable' :
          checked.metadata?.exitCode === 0 ? 'no diagnostics for the edited files' : 'check failed without locations for the edited files';
        output.push(`${kind}: ${status}`);
      }
    } catch (error) {
      output.push(`${kind}: check unavailable (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return output;
}
