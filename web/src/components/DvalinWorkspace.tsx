import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Bug, Check, CheckCircle2, ChevronRight, Circle, ExternalLink, FileCode2,
  FileSearch, GitBranch, GitPullRequest, Loader2, PackageSearch, Play, RefreshCw, Shield,
  ShieldCheck, Sparkles, Upload,
  X,
} from 'lucide-react';
import {
  createRemediationWorktree,
  fetchDvalinScanners,
  importSarifReport,
  runDvalinSecuritySuite,
  saveRemediationCases,
  updateRemediationCase,
} from '../lib/client.ts';
import type {
  DvalinScanner, DvalinScannerId, DvalinScanResult, RemediationCase, RemediationFinding,
} from '../types.ts';

type Props = {
  cwd?: string;
  sending: boolean;
  onSend: (prompt: string) => void;
  onCwdChange: (cwd: string) => void;
  onClose: () => void;
};

type WorkflowStage = 'scan' | 'fix' | 'verify' | 'publish';

const STAGES: Array<{ id: WorkflowStage; label: string; detail: string }> = [
  { id: 'scan', label: 'Scan', detail: 'SAST + dependencies + secrets + config' },
  { id: 'fix', label: 'Fix', detail: 'Evidence-backed minimal remediation' },
  { id: 'verify', label: 'Verify', detail: 'Tests, build, and security re-scan' },
  { id: 'publish', label: 'PR', detail: 'Review diff and publish a draft' },
];

function severityWeight(finding: RemediationFinding): number {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (Number.isFinite(score)) return score;
  return finding.severity === 'error' ? 8 : finding.severity === 'warning' ? 5 : 1;
}

function severityLabel(finding: RemediationFinding): 'critical' | 'high' | 'medium' | 'low' {
  const score = severityWeight(finding);
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

function severityClass(finding: RemediationFinding): string {
  const label = severityLabel(finding);
  if (label === 'critical') return 'bg-red-500/15 text-red-200 border-red-500/30';
  if (label === 'high') return 'bg-orange-500/15 text-orange-200 border-orange-500/30';
  if (label === 'medium') return 'bg-amber-500/10 text-amber-200 border-amber-500/25';
  return 'bg-blue-500/10 text-blue-200 border-blue-500/20';
}

function gradeClass(grade: DvalinScanResult['grade']): string {
  if (grade === 'A') return 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10';
  if (grade === 'B' || grade === 'C') return 'text-amber-200 border-amber-500/30 bg-amber-500/10';
  return 'text-red-200 border-red-500/30 bg-red-500/10';
}

function scannerIcon(scanner: DvalinScanner) {
  if (scanner.id === 'semgrep') return FileCode2;
  if (scanner.id === 'osv-scanner') return PackageSearch;
  if (scanner.id === 'trivy') return Shield;
  return Bug;
}

function buildFixPrompt(findings: RemediationFinding[]): string {
  return [
    'Run an automated Dvalin remediation for the confirmed scanner findings below.',
    '',
    ...findings.map((finding, index) => [
      `${index + 1}. [${severityLabel(finding).toUpperCase()}] ${finding.source} / ${finding.ruleId}`,
      `   ${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`,
      `   ${finding.message}`,
    ].join('\n')),
    '',
    'Required workflow:',
    '1. Validate each finding against the source and reachable data flow before editing; explicitly reject false positives.',
    '2. Fix confirmed vulnerabilities with the smallest behavior-preserving changes. Never weaken tests or add scanner suppressions as the fix.',
    '3. Run focused tests for every changed area, then the relevant typecheck/build commands.',
    '4. Call run_security_suite again and compare before/after findings.',
    '5. Review git diff and return a security report: fixed findings, tests, remaining risk, and draft-PR title/body.',
    'Do not commit, push, publish a PR, or merge anything in this step.',
  ].join('\n');
}

function buildVerifyPrompt(): string {
  return [
    'Verify the current Dvalin remediation without making unrelated changes.',
    'Run the focused tests for changed code, then project typecheck/build if available, and call run_security_suite.',
    'Inspect git diff for accidental test weakening, rule suppression, secrets, generated files, or unrelated edits.',
    'Report commands and exit codes, fixed versus remaining findings, regression risk, and whether the branch is ready for a draft PR.',
  ].join('\n');
}

function buildPublishPrompt(): string {
  return [
    'Publish the verified Dvalin remediation as a draft pull request.',
    'First re-check git diff/status and confirm relevant tests and security re-scan are green. Stop if verification is missing or the diff contains unrelated changes.',
    'Create a focused dvalin/security-* branch if needed, commit only the remediation files with a security-focused message, and push the branch.',
    'If the remote is GitHub and gh is authenticated, create a draft PR with summary, vulnerability impact, verification evidence, and remaining risk. For another Git host, push the branch and provide the exact merge-request creation instructions or URL supported by its CLI.',
    'Do not merge the pull request. Return the PR/MR URL and reviewer checklist.',
  ].join('\n');
}

export function DvalinWorkspace({ cwd, sending, onSend, onCwdChange, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [scanners, setScanners] = useState<DvalinScanner[]>([]);
  const [selectedScanners, setSelectedScanners] = useState<Set<DvalinScannerId>>(new Set(['builtin', 'semgrep', 'trivy', 'osv-scanner']));
  const [result, setResult] = useState<DvalinScanResult | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [scanBusy, setScanBusy] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<WorkflowStage>('scan');

  useEffect(() => {
    fetchDvalinScanners().then(setScanners).catch(error => setError(error instanceof Error ? error.message : 'Could not inspect scanners'));
  }, []);

  useEffect(() => {
    setResult(null);
    setSelectedFindings(new Set());
    setStage('scan');
  }, [cwd]);

  const runScan = async () => {
    if (!cwd || selectedScanners.size === 0) return;
    setScanBusy(true);
    setError(null);
    try {
      const next = await runDvalinSecuritySuite(cwd, [...selectedScanners]);
      setResult(next);
      setSelectedFindings(new Set(next.findings.filter(finding => severityWeight(finding) >= 7).map(finding => finding.id)));
      setScanners(current => current.map(scanner => next.scanners.find(run => run.id === scanner.id) ?? scanner));
      setStage('fix');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Dvalin scan failed');
    } finally {
      setScanBusy(false);
    }
  };

  const importSarif = async (file: File) => {
    if (!cwd) return;
    setScanBusy(true);
    setError(null);
    try {
      const imported = await importSarifReport(JSON.parse(await file.text()) as unknown, cwd);
      const cases = imported.findings.length ? await saveRemediationCases(cwd, imported.findings) : [];
      const metrics = imported.findings.reduce<DvalinScanResult['metrics']>((acc, finding) => {
        const severity = severityLabel(finding);
        acc[severity]++;
        return acc;
      }, { critical: 0, high: 0, medium: 0, low: 0, files: new Set(imported.findings.map(f => f.path)).size, rules: new Set(imported.findings.map(f => `${f.source}:${f.ruleId}`)).size });
      const score = Math.max(0, 100 - metrics.critical * 22 - metrics.high * 12 - metrics.medium * 5 - metrics.low);
      const grade: DvalinScanResult['grade'] = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
      setResult({
        id: `import-${Date.now()}`,
        source: 'Dvalin Security Suite',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        score,
        grade,
        findings: imported.findings,
        totalResults: imported.totalResults,
        skippedResults: imported.skippedResults,
        scanners: [],
        metrics,
        cases,
      });
      setSelectedFindings(new Set(imported.findings.filter(finding => severityWeight(finding) >= 7).map(finding => finding.id)));
      setStage('fix');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not import SARIF');
    } finally {
      setScanBusy(false);
    }
  };

  const caseByFinding = useMemo(() => new Map((result?.cases ?? []).map(item => [item.findingId, item])), [result?.cases]);
  const actionable = (result?.findings ?? []).filter(finding => selectedFindings.has(finding.id));

  const requestFix = async (findings: RemediationFinding[]) => {
    if (!findings.length) return;
    setStage('fix');
    for (const finding of findings) {
      const remediationCase = caseByFinding.get(finding.id);
      if (remediationCase) void updateRemediationCase(remediationCase.id, { status: 'fixing' });
    }
    onSend(buildFixPrompt(findings));
  };

  const requestIsolatedFix = async (finding: RemediationFinding) => {
    if (!cwd) return;
    setWorktreeBusy(finding.id);
    setError(null);
    try {
      const remediationCase = caseByFinding.get(finding.id);
      const worktree = await createRemediationWorktree(cwd, finding, remediationCase?.id);
      onCwdChange(worktree.cwd);
      setStage('fix');
      setTimeout(() => {
        onSend(`${worktree.prompt}\n\nAfter the minimal fix, run focused tests and run_security_suite. Do not publish or merge.`);
      }, 250);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not prepare remediation worktree');
    } finally {
      setWorktreeBusy(null);
    }
  };

  return (
    <aside className="w-[400px] xl:w-[440px] flex-shrink-0 overflow-y-auto border-l border-border bg-bg" aria-label="Dvalin status">
      <div className="px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-emerald-300 text-sm font-semibold"><ShieldCheck size={16} /> Dvalin status</div>
            <p className="mt-1 text-[10px] text-muted-fg">Scan → validate → fix → verify → draft PR</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-muted-fg hover:text-fg hover:bg-surface-2" title="Close Dvalin status panel" aria-label="Close Dvalin status panel"><X size={15} /></button>
        </div>
        <div className="mt-3 flex items-center gap-2">
            <button onClick={() => fileRef.current?.click()} disabled={!cwd || scanBusy} className="flex-1 justify-center px-2.5 py-2 rounded-lg border border-border text-[10px] text-muted-fg hover:text-fg hover:bg-surface-2 disabled:opacity-40 flex items-center gap-1.5"><Upload size={12} /> Import SARIF</button>
            <button onClick={() => void runScan()} disabled={!cwd || scanBusy || selectedScanners.size === 0} className="flex-1 justify-center px-2.5 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 text-[10px] font-medium disabled:opacity-40 flex items-center gap-1.5">
              {scanBusy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{scanBusy ? 'Scanning…' : result ? 'Run again' : 'Run full scan'}
            </button>
            <input ref={fileRef} type="file" accept=".sarif,.json,application/json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importSarif(file); event.target.value = ''; }} />
        </div>

        {!cwd && <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex gap-2"><AlertTriangle size={16} /> Select a project folder before starting a security run.</div>}
        {error && <div className="mt-5 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex gap-2"><AlertTriangle size={16} className="mt-0.5" /><span>{error}</span></div>}

        <div className="mt-4 grid grid-cols-4 gap-1.5">
          {STAGES.map((item, index) => {
            const currentIndex = STAGES.findIndex(candidate => candidate.id === stage);
            const active = item.id === stage;
            const complete = index < currentIndex;
            return <button key={item.id} onClick={() => setStage(item.id)} title={item.detail} className={`text-left rounded-lg border px-2 py-2 transition-colors ${active ? 'border-emerald-500/35 bg-emerald-500/10' : complete ? 'border-emerald-500/15 bg-emerald-500/[0.04]' : 'border-border bg-surface'}`}>
              <div className={`flex items-center gap-1 text-[10px] font-medium ${active || complete ? 'text-emerald-300' : 'text-muted-fg'}`}>{complete ? <CheckCircle2 size={11} /> : active ? <RefreshCw size={11} /> : <Circle size={10} />}{item.label}</div>
            </button>;
          })}
        </div>

        <div className="mt-3 space-y-3">
          <section className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div><div className="text-xs font-semibold">Scanner fleet</div><div className="text-[10px] text-muted-fg mt-0.5">Built-in is always available; external engines are detected from PATH.</div></div>
              <span className="text-[10px] text-muted-fg">{scanners.filter(scanner => scanner.available).length}/{scanners.length || 4} ready</span>
            </div>
            <div className="grid grid-cols-1 gap-px bg-border">
              {scanners.map(scanner => {
                const Icon = scannerIcon(scanner);
                const selected = selectedScanners.has(scanner.id);
                const run = result?.scanners.find(item => item.id === scanner.id);
                return <button key={scanner.id} onClick={() => setSelectedScanners(previous => { const next = new Set(previous); if (next.has(scanner.id)) next.delete(scanner.id); else next.add(scanner.id); return next; })} className="text-left bg-surface px-4 py-3 hover:bg-surface-2 transition-colors">
                  <div className="flex items-center gap-2"><span className={`w-7 h-7 rounded-lg flex items-center justify-center ${selected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-elevated text-muted-fg'}`}><Icon size={14} /></span><div className="min-w-0 flex-1"><div className="text-xs font-medium flex items-center gap-1.5">{scanner.name}{scanner.available ? <Check size={11} className="text-emerald-400" /> : <span className="text-[9px] text-amber-300">not installed</span>}</div><div className="text-[10px] text-muted-fg truncate">{scanner.category}</div></div>{run && <span className={`text-[9px] uppercase ${run.status === 'completed' ? 'text-emerald-300' : run.status === 'error' ? 'text-red-300' : 'text-amber-300'}`}>{run.status}</span>}</div>
                  <div className="mt-2 text-[10px] text-muted-fg/75 line-clamp-2">{scanner.description}</div>
                  {!scanner.available && scanner.installCommand && <code className="mt-2 block text-[9px] text-muted-fg/60 truncate">{scanner.installCommand}</code>}
                </button>;
              })}
              {scanners.length === 0 && <div className="bg-surface px-4 py-6 text-xs text-muted-fg flex items-center justify-center gap-2"><Loader2 size={13} className="animate-spin" /> Inspecting scanner fleet…</div>}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-start justify-between">
              <div><div className="text-xs font-semibold">Security health</div><div className="text-[10px] text-muted-fg mt-0.5">Triage heuristic, not a compliance certification.</div></div>
              {result ? <div className={`w-14 h-14 rounded-xl border flex flex-col items-center justify-center ${gradeClass(result.grade)}`}><span className="text-xl font-semibold">{result.grade}</span><span className="text-[9px]">{result.score}/100</span></div> : <div className="w-14 h-14 rounded-xl border border-border bg-elevated flex items-center justify-center text-muted-fg"><Shield size={22} /></div>}
            </div>
            <div className="mt-4 grid grid-cols-4 gap-2">
              {(['critical', 'high', 'medium', 'low'] as const).map(key => <div key={key} className="rounded-lg bg-elevated px-2 py-2 text-center"><div className="text-lg font-semibold">{result?.metrics[key] ?? '—'}</div><div className="text-[9px] uppercase text-muted-fg">{key}</div></div>)}
            </div>
            <div className="mt-3 text-[10px] text-muted-fg flex justify-between"><span>{result ? `${result.metrics.files} affected files` : 'No scan yet'}</span><span>{result ? `${result.metrics.rules} active rules` : ''}</span></div>
          </section>
        </div>

        <section className="mt-4 rounded-xl border border-border bg-surface overflow-hidden">
          <div className="px-4 py-3 border-b border-border space-y-2">
            <div><div className="text-xs font-semibold">Findings</div><div className="text-[10px] text-muted-fg mt-0.5">Select confirmed candidates for automated remediation; source validation remains mandatory.</div></div>
            <div className="grid grid-cols-3 gap-1.5">
              <button onClick={() => void requestFix(actionable)} disabled={!actionable.length || sending} className="justify-center px-2 py-1.5 rounded-lg border border-orange-500/25 bg-orange-500/10 hover:bg-orange-500/20 text-orange-200 text-[9px] disabled:opacity-40 flex items-center gap-1"><Sparkles size={10} /> Fix ({actionable.length})</button>
              <button onClick={() => { setStage('verify'); onSend(buildVerifyPrompt()); }} disabled={sending} className="justify-center px-2 py-1.5 rounded-lg border border-blue-500/25 bg-blue-500/10 hover:bg-blue-500/20 text-blue-200 text-[9px] disabled:opacity-40 flex items-center gap-1"><ShieldCheck size={10} /> Verify</button>
              <button onClick={() => { setStage('publish'); onSend(buildPublishPrompt()); }} disabled={sending} className="justify-center px-2 py-1.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-[9px] disabled:opacity-40 flex items-center gap-1"><GitPullRequest size={10} /> Draft PR</button>
            </div>
          </div>
          {!result ? <div className="px-6 py-10 text-center text-muted-fg"><FileSearch size={28} className="mx-auto opacity-30" /><div className="mt-2 text-sm">Run the scanner suite or import SARIF to begin.</div></div> : result.findings.length === 0 ? <div className="px-6 py-10 text-center text-emerald-300"><CheckCircle2 size={28} className="mx-auto" /><div className="mt-2 text-sm font-medium">No actionable findings</div><div className="mt-1 text-xs text-muted-fg">Review scanner coverage before treating this as assurance.</div></div> : (
            <div className="divide-y divide-border max-h-[420px] overflow-y-auto">
              {result.findings.map(finding => {
                const checked = selectedFindings.has(finding.id);
                const remediationCase: RemediationCase | undefined = caseByFinding.get(finding.id);
                return <div key={finding.id} className="px-4 py-3 flex items-start gap-3 hover:bg-surface-2/40">
                  <button onClick={() => setSelectedFindings(previous => { const next = new Set(previous); if (next.has(finding.id)) next.delete(finding.id); else next.add(finding.id); return next; })} className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center ${checked ? 'bg-emerald-500 border-emerald-400 text-black' : 'border-border'}`}>{checked && <Check size={11} />}</button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className={`px-1.5 py-0.5 rounded border text-[9px] uppercase ${severityClass(finding)}`}>{severityLabel(finding)}</span><span className="text-[10px] font-mono text-muted-fg truncate">{finding.source} · {finding.ruleId}</span>{remediationCase && <span className="ml-auto text-[9px] uppercase text-blue-300">{remediationCase.status.replace('_', ' ')}</span>}</div>
                    <div className="mt-1 text-xs text-fg">{finding.message}</div>
                    <div className="mt-1 text-[10px] font-mono text-muted-fg">{finding.path}{finding.startLine ? `:${finding.startLine}` : ''}</div>
                  </div>
                  <button onClick={() => void requestIsolatedFix(finding)} disabled={!cwd || worktreeBusy !== null || sending} title="Fix in isolated worktree" className="flex-shrink-0 p-1.5 rounded-lg border border-border text-[10px] text-muted-fg hover:text-fg hover:bg-elevated disabled:opacity-40 flex items-center">
                    {worktreeBusy === finding.id ? <Loader2 size={10} className="animate-spin" /> : <GitBranch size={10} />}<ChevronRight size={9} />
                  </button>
                </div>;
              })}
            </div>
          )}
        </section>

        <div className="mt-4 text-[9px] text-muted-fg/60 space-y-1">
          <div>External scanners may download rule or vulnerability databases when policy permits network access.</div>
          <a href="https://sarifweb.azurewebsites.net/" target="_blank" rel="noreferrer" className="hover:text-fg flex items-center gap-1">SARIF 2.1 interoperability <ExternalLink size={9} /></a>
        </div>
      </div>
    </aside>
  );
}
