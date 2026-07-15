import { readRecords, type AuditRecord } from './log.js';

/**
 * Render a run's JSONL audit log into a Markdown Run Report. Pure function over
 * the log — the rendering layer described in the v0.5 roadmap (P0-1 FR-2).
 */
export function renderReport(runId: string, dir?: string): string {
  const records = readRecords(runId, dir);
  return renderRecords(runId, records);
}

/** Same as renderReport but over already-parsed records (testable without IO). */
export function renderRecords(runId: string, records: AuditRecord[]): string {
  const start = records.find(r => r.type === 'run_start') as
    | Extract<AuditRecord, { type: 'run_start' }>
    | undefined;
  const end = records.find(r => r.type === 'run_end') as
    | Extract<AuditRecord, { type: 'run_end' }>
    | undefined;

  const reads = records.filter(r => r.type === 'file_read') as Extract<AuditRecord, { type: 'file_read' }>[];
  const writes = records.filter(r => r.type === 'file_write') as Extract<AuditRecord, { type: 'file_write' }>[];
  const deletes = records.filter(r => r.type === 'file_delete') as Extract<AuditRecord, { type: 'file_delete' }>[];
  const shells = records.filter(r => r.type === 'shell_exec') as Extract<AuditRecord, { type: 'shell_exec' }>[];
  const approvals = records.filter(r => r.type === 'approval') as Extract<AuditRecord, { type: 'approval' }>[];
  const violations = records.filter(r => r.type === 'policy_violation') as Extract<
    AuditRecord,
    { type: 'policy_violation' }
  >[];

  const lines: string[] = [];
  lines.push(`# Run Report — \`${runId}\``);
  lines.push('');

  // Task / metadata
  if (start) {
    lines.push(`**Task:** ${start.task}`);
    lines.push('');
    lines.push(`- Mode: \`${start.mode}\``);
    lines.push(`- Provider/model: \`${start.provider}\` / \`${start.model}\``);
    lines.push(`- Working dir: \`${start.cwd}\``);
    lines.push(`- Git HEAD: ${start.gitHead ? `\`${start.gitHead}\`` : '_(not a git repo)_'}`);
    lines.push('');
  }

  // Files changed (dedupe by path, keep last write)
  lines.push('## Files changed');
  if (writes.length === 0 && deletes.length === 0) {
    lines.push('_No files written._');
  } else {
    for (const w of writes) {
      lines.push(`- \`${w.path}\` (+${w.added}/−${w.removed})`);
    }
    for (const d of deletes) {
      lines.push(`- \`${d.path}\` _(deleted)_`);
    }
  }
  lines.push('');

  // Files read
  lines.push('## Files read');
  if (reads.length === 0) {
    lines.push('_None._');
  } else {
    const seen = new Set<string>();
    for (const r of reads) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      lines.push(`- \`${r.path}\``);
    }
  }
  lines.push('');

  // Commands run
  lines.push('## Commands run');
  if (shells.length === 0) {
    lines.push('_None._');
  } else {
    for (const s of shells) {
      const sandbox = s.sandbox === 'none' ? '' : ` _(sandbox: ${s.sandbox})_`;
      lines.push(`- \`${s.command}\` → exit ${s.exitCode ?? '?'}${sandbox}`);
    }
  }
  lines.push('');

  // Decisions: approvals + policy violations
  if (approvals.length > 0 || violations.length > 0) {
    lines.push('## Decisions');
    for (const a of approvals) {
      lines.push(`- ${a.approved ? '✅ approved' : '⛔ rejected'} \`${a.toolName}\``);
    }
    for (const v of violations) {
      lines.push(`- 🛑 policy \`${v.rule}\` blocked \`${v.tool}\` on \`${v.target}\``);
    }
    lines.push('');
  }

  // Test result (heuristic: last shell matching a test/lint command)
  const testRun = [...shells].reverse().find(s => /\b(test|lint|vitest|jest|pytest|tsc|check)\b/.test(s.command));
  lines.push('## Test result');
  if (testRun) {
    const ok = testRun.exitCode === 0;
    lines.push(`${ok ? '✅ passed' : '❌ failed'} — \`${testRun.command}\` (exit ${testRun.exitCode ?? '?'})`);
  } else {
    lines.push('_No test/lint command detected._');
  }
  lines.push('');

  // Summary footer
  lines.push('## Summary');
  if (end) {
    lines.push(`- Status: **${end.status}**`);
    lines.push(`- Iterations: ${end.iterations}`);
    if (end.inputTokens !== undefined || end.outputTokens !== undefined) {
      lines.push(`- Tokens: ${end.inputTokens ?? 0} in / ${end.outputTokens ?? 0} out`);
    }
    if (
      end.cachedInputTokens !== undefined ||
      end.cacheMissInputTokens !== undefined ||
      end.cacheWriteInputTokens !== undefined
    ) {
      lines.push(
        `- Prompt cache: ${end.cachedInputTokens ?? 0} hit / ${end.cacheMissInputTokens ?? 0} miss / ${end.cacheWriteInputTokens ?? 0} write`,
      );
    }
    if (end.warnings && end.warnings.length > 0) {
      lines.push(`- ⚠️ Warnings: ${end.warnings.join('; ')}`);
    }
  } else {
    lines.push('- Status: **incomplete** (no run_end recorded)');
  }

  return lines.join('\n') + '\n';
}
