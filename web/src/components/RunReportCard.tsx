import { rollbackRun } from '../lib/client.ts';
import type { CheckpointStatus } from '../types.ts';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ShieldCheck, ChevronDown, ChevronUp, Copy, Check, Download } from 'lucide-react';

type Props = {
  runId: string;
  markdown: string;
  checkpoint?: CheckpointStatus;
};

/**
 * Collapsible card rendering a run's audit-trail Run Report at the end of the
 * thread, with a rollback action for eligible checkpoints.
 */
export function RunReportCard({ runId, markdown, checkpoint }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [copied, setCopied] = useState(false);
  const [rollbackStatus, setRollbackStatus] = useState('');
  const [closed, setClosed] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const restore = async () => {
    setRollingBack(true);
    try {
      setRollbackStatus(await rollbackRun(runId));
      setClosed(true);
    } catch (error) {
      setRollbackStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRollingBack(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — silently ignore
    }
  };

  const exportFile = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `run-report-${runId}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-3 border border-emerald-500/25 rounded-xl overflow-hidden bg-emerald-500/5">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-500/10 border-b border-emerald-500/20">
        <ShieldCheck size={13} className="text-success-fg flex-shrink-0" />
        <span className="text-xs font-semibold text-success-fg">Run Report · audit trail</span>
        <button
          onClick={copy}
          title="Copy markdown"
          className="ml-auto text-success-fg/60 hover:text-success-fg transition-colors"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          onClick={exportFile}
          title="Export .md"
          className="text-success-fg/60 hover:text-success-fg transition-colors"
        >
          <Download size={13} />
        </button>
        <button
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? 'Expand' : 'Collapse'}
          className="text-success-fg/60 hover:text-success-fg transition-colors"
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>

      {collapsed ? (
        <div className="px-4 py-2 text-xs text-muted-fg font-mono truncate">{runId}</div>
      ) : (
        <div className="prose text-xs px-4 py-3 max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </div>
      )}
      {checkpoint && 'unavailable' in checkpoint && (
        <div className="px-4 py-2 text-xs text-muted-fg">{checkpoint.unavailable}</div>
      )}
      {checkpoint && 'changed' in checkpoint && checkpoint.changed > 0 && !closed && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs">
          <span className="text-muted-fg">{checkpoint.changed} file(s) in checkpoint</span>
          <button onClick={() => void restore()} disabled={rollingBack} className="rounded-md border border-border px-2 py-1 text-danger-fg">Rollback</button>
          <button onClick={() => { setClosed(true); setRollbackStatus(''); }} disabled={rollingBack} className="rounded-md border border-border px-2 py-1 text-fg">Keep changes</button>
        </div>
      )}
      {rollbackStatus && <p role="status" className="px-4 py-2 text-xs text-fg">{rollbackStatus}</p>}
    </div>
  );
}
