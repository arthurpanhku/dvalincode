import type { DvalinContext } from '../core/context.js';
import type { ToolAccess, ToolResult } from '../tools/types.js';
import { fingerprint, summarizeToolInput } from './minimize.js';

/**
 * Translate one tool execution into audit events on the context's sink. Emits a
 * `tool_call` for every call plus a derived `file_*` / `shell_exec` event built
 * from the metadata the tools already produce. No-op when no sink is attached.
 */
export function emitToolAudit(
  context: DvalinContext,
  access: ToolAccess,
  name: string,
  input: unknown,
  result: ToolResult | undefined,
  status: 'ok' | 'error',
  durationMs: number,
): void {
  const sink = context.audit;
  if (!sink) return;

  sink.append({ type: 'tool_call', tool: name, argsSummary: summarizeToolInput(name, input), status, durationMs });

  // Derived events only make sense for a successful call with metadata.
  if (status !== 'ok' || !result) return;
  const meta = result.metadata ?? {};

  switch (name) {
    case 'read_file': {
      if (typeof meta.path === 'string' && typeof meta.sha256 === 'string') {
        sink.append({ type: 'file_read', path: meta.path, sha256: meta.sha256 });
      }
      break;
    }
    case 'write_file':
    case 'edit_file': {
      if (typeof meta.path === 'string') {
        sink.append({
          type: 'file_write',
          path: meta.path,
          added: numOr0(meta.added),
          removed: numOr0(meta.removed),
          beforeHash: typeof meta.beforeHash === 'string' ? meta.beforeHash : null,
          afterHash: typeof meta.afterHash === 'string' ? meta.afterHash : '',
        });
      }
      break;
    }
    case 'delete_file': {
      if (typeof meta.path === 'string') {
        sink.append({
          type: 'file_delete',
          path: meta.path,
          beforeHash: typeof meta.beforeHash === 'string' ? meta.beforeHash : null,
        });
      }
      break;
    }
    case 'shell':
    case 'run_check': {
      if (typeof meta.command === 'string') {
        const fp = fingerprint(input);
        sink.append({
          type: 'shell_exec',
          command: meta.command,
          argsCount: typeof meta.argsCount === 'number' ? meta.argsCount : undefined,
          inputHash: fp.sha256,
          exitCode: typeof meta.exitCode === 'number' ? meta.exitCode : null,
          sandbox: meta.sandbox === 'seatbelt' || meta.sandbox === 'bwrap' ? meta.sandbox : 'none',
        });
      }
      break;
    }
  }
}

function numOr0(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
