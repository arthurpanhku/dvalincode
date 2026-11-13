import { Check, X, AlertTriangle, Trash2 } from 'lucide-react';
import { DiffViewer } from './DiffViewer.tsx';
import type { PendingApproval, DiffLine } from '../types.ts';

type Props = {
  approval: PendingApproval;
  onRespond: (id: string, approved: boolean, scope?: 'run', choice?: number) => void;
};

/* ── Client-side diff (same algorithm as backend generateDiff) ─── */
function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const o = oldLines[i] ?? '';
    const n = newLines[i] ?? '';
    if (o === n) {
      result.push({ type: 'keep', content: o });
    } else {
      if (i < oldLines.length) result.push({ type: 'remove', content: o });
      if (i < newLines.length) result.push({ type: 'add', content: n });
    }
  }
  return result;
}

/* ── Per-tool content rendering ─────────────────────────────────── */
function ApprovalContent({ toolName, input }: { toolName: string; input: unknown }) {
  if (!input || typeof input !== 'object') {
    return (
      <pre className="px-4 py-3 text-xs font-mono text-muted-fg bg-bg overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
        {String(input)}
      </pre>
    );
  }

  const obj = input as Record<string, unknown>;

  /* shell_sandbox_bypass — explicit unrestricted network approval */
  if (toolName === 'shell_sandbox_bypass') {
    const command = typeof obj.command === 'string' ? obj.command : '';
    const args = Array.isArray(obj.args) ? (obj.args as string[]).join(' ') : '';
    const full = args ? `${command} ${args}` : command;
    const reason = typeof obj.reason === 'string' ? obj.reason : 'This command requested unrestricted outbound network access.';
    return (
      <div className="bg-bg">
        <div className="px-4 py-2 border-b border-border text-[11px] text-danger-fg/80">
          This will run outside the local subprocess network sandbox. Organization policy still applies.
        </div>
        <pre className="px-4 py-3 text-xs font-mono text-warn-fg overflow-x-auto whitespace-pre-wrap break-all">
          {full}
        </pre>
        <div className="px-4 pb-3 text-xs text-muted-fg">
          {reason}
        </div>
      </div>
    );
  }

  /* web_fetch — first request to a site in this turn */
  if (toolName === 'web_fetch') {
    const url = typeof obj.url === 'string' ? obj.url : '';
    const host = typeof obj.host === 'string' ? obj.host : '';
    return (
      <div className="bg-bg">
        <div className="px-4 py-2 border-b border-border text-[11px] text-muted-fg">
          Allow reading pages from <span className="font-mono text-fg">{host}</span> for the rest of this turn. Organization policy still applies.
        </div>
        <pre className="px-4 py-3 text-xs font-mono text-info-fg overflow-x-auto whitespace-pre-wrap break-all">
          {url}
        </pre>
      </div>
    );
  }

  /* edit_file — show unified diff (one per edit for a batch) */
  if (toolName === 'apply_patch' && Array.isArray(obj.files)) {
    return (
      <div className="max-h-72 overflow-y-auto p-3 space-y-2">
        {obj.files.map((file: Record<string, unknown>, index: number) => (
          <div key={index}>
            <p className="text-xs font-mono text-fg mb-1">{String(file.filePath)}</p>
            <DiffViewer diff={computeDiff(String(file.oldString ?? ''), String(file.newString ?? ''))} />
          </div>
        ))}
      </div>
    );
  }
  if (toolName === 'edit_file') {
    const filePath = typeof obj.filePath === 'string' ? obj.filePath : undefined;
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const edits = (Array.isArray(obj.edits) ? obj.edits : [obj]) as Record<string, unknown>[];
    return (
      <div className="px-4 py-3 bg-bg flex flex-col gap-2 max-h-96 overflow-y-auto">
        {edits.map((edit, i) => (
          <div key={i}>
            {(edits.length > 1 || edit.replaceAll === true) && (
              <div className="text-[11px] text-muted-fg mb-1">
                {edits.length > 1 ? `Edit ${i + 1} of ${edits.length}` : ''}
                {edits.length > 1 && edit.replaceAll === true ? ' · ' : ''}
                {edit.replaceAll === true ? 'every occurrence' : ''}
              </div>
            )}
            <DiffViewer diff={computeDiff(text(edit.oldString), text(edit.newString))} filePath={i === 0 ? filePath : undefined} />
          </div>
        ))}
      </div>
    );
  }

  /* write_file — show path + content preview */
  if (toolName === 'write_file') {
    const filePath = typeof obj.filePath === 'string' ? obj.filePath : '?';
    const content = typeof obj.content === 'string' ? obj.content : '';
    const lines = content.split('\n');
    const preview = lines.slice(0, 12).join('\n') + (lines.length > 12 ? `\n… +${lines.length - 12} lines` : '');
    return (
      <div className="bg-bg">
        <div className="px-4 py-2 border-b border-border text-[11px] font-mono text-muted-fg">
          {filePath} <span className="text-muted-fg">· {lines.length} lines · {content.length} chars</span>
        </div>
        <pre className="px-4 py-3 text-xs font-mono text-muted-fg overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
          {preview}
        </pre>
      </div>
    );
  }

  /* delete_file — warning */
  if (toolName === 'delete_file') {
    const filePath = typeof obj.filePath === 'string' ? obj.filePath : '?';
    return (
      <div className="px-4 py-4 bg-bg flex items-center gap-3">
        <Trash2 size={16} className="text-danger-fg flex-shrink-0" />
        <div>
          <div className="text-sm text-danger-fg font-medium">{filePath}</div>
          <div className="text-xs text-muted-fg mt-0.5">This file will be permanently deleted.</div>
        </div>
      </div>
    );
  }

  /* shell — command with highlighting */
  if (toolName === 'shell') {
    const command = typeof obj.command === 'string' ? obj.command : '';
    const args = Array.isArray(obj.args) ? (obj.args as string[]).join(' ') : '';
    const full = args ? `${command} ${args}` : command;
    return (
      <div className="bg-bg">
        <div className="px-4 py-1.5 border-b border-border text-[11px] text-warn-fg/60 font-mono">$ shell</div>
        <pre className="px-4 py-3 text-xs font-mono text-warn-fg overflow-x-auto whitespace-pre-wrap break-all">
          {full}
        </pre>
      </div>
    );
  }

  /* fallback */
  return (
    <pre className="px-4 py-3 text-xs font-mono text-muted-fg bg-bg overflow-x-auto max-h-48 whitespace-pre-wrap break-all">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

/* ── Main dialog ─────────────────────────────────────────────────── */
const TOOL_META: Record<string, { icon: string; label: string; bg: string; badge: string; badgeStyle: string }> = {
  shell:       { icon: '⚡', label: 'shell',       bg: 'bg-orange-500/5', badge: 'execute',   badgeStyle: 'text-warn-fg bg-orange-500/10 border-orange-500/20' },
  shell_sandbox_bypass: { icon: '⚡', label: 'unrestricted network', bg: 'bg-red-500/5', badge: 'sandbox bypass', badgeStyle: 'text-danger-fg bg-red-500/10 border-red-500/20' },
  write_file:  { icon: '📝', label: 'write_file',  bg: 'bg-yellow-500/5', badge: 'write',     badgeStyle: 'text-warn-fg bg-yellow-500/10 border-yellow-500/20' },
  edit_file:   { icon: '✏️',  label: 'edit_file',  bg: 'bg-blue-500/5',   badge: 'edit',      badgeStyle: 'text-info-fg bg-blue-500/10 border-blue-500/20' },
  delete_file: { icon: '🗑️', label: 'delete_file', bg: 'bg-red-500/5',    badge: 'delete',    badgeStyle: 'text-danger-fg bg-red-500/10 border-red-500/20' },
  web_fetch:   { icon: '🌐', label: 'web_fetch',   bg: 'bg-blue-500/5',   badge: 'web access', badgeStyle: 'text-info-fg bg-blue-500/10 border-blue-500/20' },
};

export function ApprovalDialog({ approval, onRespond }: Props) {
  if (approval.toolName === 'ask_user') {
    const input = approval.input as { question: string; options: string[] };
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center pb-24 px-4 pointer-events-none">
        <div role="dialog" aria-label="Question from the agent" className="pointer-events-auto w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl p-4">
          <p className="text-sm text-fg mb-3">{input.question}</p>
          <div className="flex flex-wrap gap-2">
            {input.options.map((option, index) => (
              <button key={index} className="px-3 py-1.5 text-xs border border-border rounded-lg text-fg"
                onClick={() => onRespond(approval.id, true, undefined, index)}>{option}</button>
            ))}
            <button className="px-3 py-1.5 text-xs text-muted-fg" onClick={() => onRespond(approval.id, false)}>Skip</button>
          </div>
        </div>
      </div>
    );
  }

  const meta = TOOL_META[approval.toolName] ?? {
    icon: '🔧', label: approval.toolName, bg: 'bg-yellow-500/5',
    badge: 'confirm', badgeStyle: 'text-warn-fg bg-yellow-500/10 border-yellow-500/20',
  };

  const isDelete = approval.toolName === 'delete_file';
  const isSandboxBypass = approval.toolName === 'shell_sandbox_bypass';

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center pb-24 px-4 pointer-events-none">
      <div className="pointer-events-auto w-full max-w-xl bg-surface border border-border rounded-xl shadow-2xl overflow-hidden animate-slide-up">
        {/* Header */}
        <div className={`flex items-center gap-2 px-4 py-3 border-b border-border ${meta.bg}`}>
          <span className="text-base">{meta.icon}</span>
          <span className="text-sm font-medium text-fg">{meta.label}</span>
          {isDelete && (
            <AlertTriangle size={13} className="text-danger-fg ml-0.5" />
          )}
          <span className={`ml-auto text-[11px] px-2 py-0.5 rounded font-mono border ${meta.badgeStyle}`}>
            {meta.badge}
          </span>
        </div>

        {/* Content */}
        <ApprovalContent toolName={approval.toolName} input={approval.input} />

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={() => onRespond(approval.id, false)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-danger-fg hover:text-danger-fg bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 rounded-lg transition-colors"
          >
            <X size={12} />
            Deny
          </button>
          <button
            onClick={() => onRespond(approval.id, true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border rounded-lg transition-colors ${
              isDelete
                ? 'text-danger-fg hover:text-danger-fg bg-red-500/10 hover:bg-red-500/15 border-red-500/20'
                : 'text-success-fg hover:text-success-fg bg-emerald-500/10 hover:bg-emerald-500/15 border-emerald-500/20'
            }`}
          >
            <Check size={12} />
            {isDelete ? 'Delete' : 'Allow'}
            {isSandboxBypass ? ' unrestricted' : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
