import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileSearch, FileWarning, GitBranch, Loader2, ShieldCheck, Upload, Wrench } from 'lucide-react';
import {
  createRemediationWorktree,
  fetchRemediationCases,
  importSarifReport,
  runLocalSecurityScan,
  saveRemediationCases,
  updateRemediationCase,
} from '../lib/client.ts';
import type { RemediationCase, RemediationFinding, SarifImportResult } from '../types.ts';

type Props = {
  cwd?: string;
  onSend: (text: string) => void;
  onCwdChange?: (cwd: string) => void;
};

function severityClass(finding: RemediationFinding): string {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (finding.severity === 'error' || score >= 8) return 'text-red-300 border-red-500/20 bg-red-500/10';
  if (finding.severity === 'warning' || score >= 4) return 'text-orange-300 border-orange-500/20 bg-orange-500/10';
  return 'text-blue-300 border-blue-500/20 bg-blue-500/10';
}

function locationLabel(finding: RemediationFinding): string {
  return `${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`;
}

function caseLocationLabel(remediationCase: RemediationCase): string {
  return `${remediationCase.path}${remediationCase.startLine ? `:${remediationCase.startLine}` : ''}`;
}

function statusClass(status: RemediationCase['status']): string {
  switch (status) {
    case 'verified':
      return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20';
    case 'worktree_ready':
    case 'fixing':
      return 'text-blue-300 bg-blue-500/10 border-blue-500/20';
    case 'dismissed':
      return 'text-muted-fg bg-surface-2 border-border';
    default:
      return 'text-orange-300 bg-orange-500/10 border-orange-500/20';
  }
}

export function SecurityRemediation({ cwd, onSend, onCwdChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SarifImportResult | null>(null);
  const [cases, setCases] = useState<RemediationCase[]>([]);
  const [worktreePrompts, setWorktreePrompts] = useState<Record<string, { branch: string; prompt: string }>>({});

  useEffect(() => {
    void fetchRemediationCases(cwd).then(setCases).catch(() => {});
  }, [cwd]);

  const persistFindings = async (nextResult: SarifImportResult) => {
    setResult(nextResult);
    if (nextResult.findings.length === 0) return;
    const saved = await saveRemediationCases(cwd, nextResult.findings);
    setCases((prev) => {
      const byId = new Map(prev.map(item => [item.id, item]));
      for (const item of saved) byId.set(item.id, item);
      return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  };

  const importFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const report = JSON.parse(await file.text()) as unknown;
      await persistFindings(await importSarifReport(report, cwd));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import SARIF');
    } finally {
      setBusy(false);
    }
  };

  const scanWorkspace = async () => {
    setBusy(true);
    setError(null);
    try {
      await persistFindings(await runLocalSecurityScan(cwd));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run local scan');
    } finally {
      setBusy(false);
    }
  };

  const prepareWorktree = async (finding: RemediationFinding) => {
    if (!cwd) return;
    setWorktreeBusy(finding.id);
    setError(null);
    try {
      const remediationCase = cases.find(item => item.findingId === finding.id);
      const worktree = await createRemediationWorktree(cwd, finding, remediationCase?.id);
      setWorktreePrompts((prev) => ({
        ...prev,
        [finding.id]: { branch: worktree.branch, prompt: worktree.prompt },
      }));
      if (remediationCase) {
        setCases((prev) => prev.map(item => item.id === remediationCase.id
          ? { ...item, status: 'worktree_ready', branch: worktree.branch, worktreeCwd: worktree.cwd, prompt: worktree.prompt }
          : item));
      }
      onCwdChange?.(worktree.cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create remediation worktree');
    } finally {
      setWorktreeBusy(null);
    }
  };

  const findings = result?.findings.slice(0, 5) ?? [];
  const importedCount = result?.findings.length ?? 0;
  const hiddenCount = Math.max(0, importedCount - findings.length);
  const caseByFindingId = new Map(cases.map(item => [item.findingId, item]));
  const recentCases = cases.slice(0, 4);

  const sendFinding = async (finding: RemediationFinding) => {
    const remediationCase = caseByFindingId.get(finding.id);
    if (remediationCase) {
      setCases((prev) => prev.map(item => item.id === remediationCase.id ? { ...item, status: 'fixing' } : item));
      updateRemediationCase(remediationCase.id, { status: 'fixing' }).catch(() => {});
    }
    onSend(worktreePrompts[finding.id]?.prompt ?? remediationCase?.prompt ?? finding.prompt);
  };

  return (
    <div className="px-3 pb-2 border-b border-border">
      <div className="flex items-center justify-between px-1 mb-1">
        <span className="text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider">
          Security
        </span>
        {result && (
          <span className="text-[10px] text-muted-fg/50">
            {result.findings.length}/{result.totalResults}
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1">
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2 border border-border/60 transition-colors disabled:opacity-50"
        >
          {busy ? <ShieldCheck size={12} className="text-blue-400 animate-pulse" /> : <Upload size={12} className="text-emerald-400/80" />}
          <span className="truncate flex-1 text-left">{busy ? 'Working…' : 'Import SARIF'}</span>
        </button>
        <button
          onClick={() => void scanWorkspace()}
          disabled={busy || !cwd}
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-muted-fg hover:text-fg hover:bg-surface-2 border border-border/60 transition-colors disabled:opacity-50"
        >
          {busy ? <ShieldCheck size={12} className="text-blue-400 animate-pulse" /> : <FileSearch size={12} className="text-orange-400/80" />}
          <span className="truncate flex-1 text-left">{busy ? 'Working…' : 'Local scan'}</span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".sarif,.json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importFile(file);
          e.target.value = '';
        }}
      />

      {error && (
        <div className="mt-1.5 flex gap-1.5 px-2 py-1.5 rounded-lg border border-red-500/20 bg-red-500/10 text-[10px] text-red-300">
          <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && result.findings.length === 0 && (
        <div className="mt-1.5 px-2 py-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-[10px] text-emerald-300">
          No actionable security findings found
        </div>
      )}

      {findings.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {findings.map((finding) => (
            <div key={finding.id} className="group rounded-lg border border-border/60 bg-elevated/60 px-2 py-1.5">
              <div className="flex items-start gap-1.5">
                <FileWarning size={11} className="text-orange-400/80 mt-0.5 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded border text-[9px] uppercase ${severityClass(finding)}`}>
                      {finding.securitySeverity ?? finding.severity}
                    </span>
                    <span className="text-[10px] font-mono text-muted-fg truncate">{finding.ruleId}</span>
                  </div>
                  <div className="mt-1 text-[10px] text-fg line-clamp-2">
                    {finding.message}
                  </div>
                  <div className="mt-1 text-[10px] text-muted-fg/70 font-mono truncate">
                    {locationLabel(finding)}
                  </div>
                </div>
              </div>
              <button
                onClick={() => void sendFinding(finding)}
                className="mt-1.5 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md bg-orange-500/10 hover:bg-orange-500/20 text-orange-300 border border-orange-500/20 text-[10px] transition-colors"
              >
                <Wrench size={10} />
                Fix finding
              </button>
              <button
                onClick={() => void prepareWorktree(finding)}
                disabled={!cwd || worktreeBusy !== null}
                className="mt-1 w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/20 text-[10px] transition-colors disabled:opacity-50"
              >
                {worktreeBusy === finding.id ? <Loader2 size={10} className="animate-spin" /> : <GitBranch size={10} />}
                {worktreePrompts[finding.id] ? 'Worktree ready' : 'Create worktree'}
              </button>
              {worktreePrompts[finding.id] && (
                <div className="mt-1 text-[9px] text-blue-300/80 font-mono truncate">
                  {worktreePrompts[finding.id].branch}
                </div>
              )}
            </div>
          ))}
          {hiddenCount > 0 && (
            <div className="text-[10px] text-muted-fg/50 px-2">
              {hiddenCount} more findings imported
            </div>
          )}
        </div>
      )}

      {recentCases.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border/60">
          <div className="px-1 mb-1 text-[10px] font-semibold text-muted-fg/50 uppercase tracking-wider">
            Cases
          </div>
          <div className="flex flex-col gap-1">
            {recentCases.map((item) => (
              <div key={item.id} className="rounded-lg border border-border/50 bg-elevated/40 px-2 py-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={`px-1.5 py-0.5 rounded border text-[9px] uppercase ${statusClass(item.status)}`}>
                    {item.status.replace('_', ' ')}
                  </span>
                  <span className="text-[10px] font-mono text-muted-fg truncate">{item.ruleId}</span>
                </div>
                <div className="mt-1 text-[10px] text-muted-fg/70 font-mono truncate">
                  {caseLocationLabel(item)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
