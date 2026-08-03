import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Bug, Check, CheckCircle2, ChevronRight, Circle, Code2, Download, ExternalLink,
  Eye, FileCode2, FileSearch, GitBranch, GitPullRequest, Loader2, PackageSearch, Play, RefreshCw,
  Shield, ShieldCheck, Sparkles, Terminal, TestTube2, Upload, Wrench,
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
  connected: boolean;
  sending: boolean;
  onSend: (prompt: string) => void;
  onReconnect: () => void;
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

const REMEDIATION_CAPABILITIES = [
  { label: 'Validate', detail: 'Inspect code & data flow', icon: Eye },
  { label: 'Repair', detail: 'Make focused code edits', icon: Code2 },
  { label: 'Prove', detail: 'Run tests & builds', icon: TestTube2 },
  { label: 'Review', detail: 'Re-scan & prepare PR', icon: GitPullRequest },
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

export function DvalinWorkspace({ cwd, connected, sending, onSend, onReconnect, onCwdChange, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [scanners, setScanners] = useState<DvalinScanner[]>([]);
  const [selectedScanners, setSelectedScanners] = useState<Set<DvalinScannerId>>(new Set(['builtin']));
  const [result, setResult] = useState<DvalinScanResult | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Set<string>>(new Set());
  const [scanBusy, setScanBusy] = useState(false);
  const [scannerBusy, setScannerBusy] = useState(false);
  const [scannerReady, setScannerReady] = useState(false);
  const [installRequested, setInstallRequested] = useState<DvalinScannerId | null>(null);
  const [worktreeBusy, setWorktreeBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<WorkflowStage>('scan');

  const inspectScanners = async () => {
    if (!connected) {
      setScannerReady(false);
      setError('Dvalin service is unavailable. Reconnect before starting a scan.');
      return;
    }
    setScannerBusy(true);
    try {
      const next = await fetchDvalinScanners();
      const previouslyAvailable = new Set(scanners.filter(scanner => scanner.available).map(scanner => scanner.id));
      setScanners(next);
      setSelectedScanners(previous => new Set(next
        .filter(scanner => scanner.available && (previous.has(scanner.id) || !previouslyAvailable.has(scanner.id)))
        .map(scanner => scanner.id)));
      setInstallRequested(current => current && next.some(scanner => scanner.id === current && scanner.available) ? null : current);
      setScannerReady(true);
      setError(null);
    } catch (error) {
      setScannerReady(false);
      setError(error instanceof TypeError
        ? 'Could not reach the Dvalin service. Relaunch the desktop app or start the web and API services together.'
        : error instanceof Error ? error.message : 'Could not inspect scanners');
    } finally {
      setScannerBusy(false);
    }
  };

  useEffect(() => {
    if (connected) {
      void inspectScanners();
    } else {
      setScannerReady(false);
    }
    // Re-run scanner discovery whenever the local service reconnects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  useEffect(() => {
    setResult(null);
    setSelectedFindings(new Set());
    setStage('scan');
  }, [cwd]);

  const runScan = async () => {
    if (!cwd || !connected || !scannerReady || selectedScanners.size === 0) return;
    setScanBusy(true);
    setError(null);
    try {
      const next = await runDvalinSecuritySuite(cwd, [...selectedScanners]);
      setResult(next);
      setSelectedFindings(new Set(next.findings.filter(finding => severityWeight(finding) >= 7).map(finding => finding.id)));
      setScanners(current => current.map(scanner => next.scanners.find(run => run.id === scanner.id) ?? scanner));
      setStage('fix');
    } catch (error) {
      if (error instanceof TypeError) setScannerReady(false);
      setError(error instanceof TypeError
        ? 'The Dvalin service disconnected before the scan could start. Reconnect and try again.'
        : error instanceof Error ? error.message : 'Dvalin scan failed');
    } finally {
      setScanBusy(false);
    }
  };

  const retryService = () => {
    setError(null);
    if (connected) {
      void inspectScanners();
    } else {
      onReconnect();
    }
  };

  const requestScannerInstall = (scanner: DvalinScanner) => {
    if (!scanner.installCommand) return;
    setInstallRequested(scanner.id);
    onSend([
      `Install ${scanner.name} so Dvalin can expand its ${scanner.category} coverage.`,
      `Use this project-provided install command: ${scanner.installCommand}`,
      'First confirm the command is compatible with this operating system and package manager. If it is not, use the equivalent official installation method and explain the substitution.',
      'After installation, verify the executable and version are available on PATH. Do not change project source code or start a security scan in this step.',
    ].join('\n'));
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

  const availableScanners = scanners.filter(scanner => scanner.available);
  const missingScanners = scanners.filter(scanner => !scanner.available);

  return (
    <aside className="w-[420px] xl:w-[460px] flex-shrink-0 overflow-y-auto border-l border-border bg-bg" aria-label="Dvalin status">
      <div className="px-4 py-4">
        <div className="rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-surface to-surface px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-emerald-500/25 bg-emerald-500/15 text-emerald-300"><ShieldCheck size={18} /></span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-fg-strong">Dvalin security workspace</h2>
                  <span className={`rounded-full border px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide ${cwd && connected && scannerReady ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/25 bg-amber-500/10 text-amber-300'}`}>{!cwd ? 'no project' : !connected ? 'offline' : scannerReady ? 'ready' : 'checking'}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted-fg">Find defects, repair code, and prove the fix.</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-md text-muted-fg hover:text-fg hover:bg-surface-2" title="Close Dvalin status panel" aria-label="Close Dvalin status panel"><X size={15} /></button>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button onClick={() => void runScan()} disabled={!cwd || !connected || !scannerReady || scanBusy || selectedScanners.size === 0} className="flex-[1.35] justify-center px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 text-[10px] font-semibold disabled:opacity-40 flex items-center gap-1.5">
              {scanBusy || (connected && !scannerReady) ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}{scanBusy ? 'Scanning project…' : connected && !scannerReady ? 'Checking engines…' : result ? 'Re-run security scan' : 'Scan project'}
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={!cwd || !connected || scanBusy} className="flex-1 justify-center px-2.5 py-2 rounded-lg border border-border bg-bg/30 text-[10px] text-muted-fg hover:text-fg hover:bg-surface-2 disabled:opacity-40 flex items-center gap-1.5"><Upload size={12} /> Import SARIF</button>
            <input ref={fileRef} type="file" accept=".sarif,.json,application/json" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void importSarif(file); event.target.value = ''; }} />
          </div>
        </div>

        {!cwd && <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex gap-2"><AlertTriangle size={16} /> Select a project folder before starting a security run.</div>}
        {!connected && <div className="mt-5 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /><span className="min-w-0 flex-1">Dvalin service is offline. Relaunch the desktop app, or start the web and API services together.</span><button onClick={retryService} className="flex-shrink-0 rounded-md border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide hover:bg-amber-500/20">Retry</button></div>}
        {error && connected && <div className="mt-5 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2"><AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /><span className="min-w-0 flex-1">{error}</span>{!scannerReady && <button onClick={retryService} className="flex-shrink-0 rounded-md border border-red-400/25 bg-red-500/10 px-2 py-1 text-[9px] font-semibold uppercase tracking-wide hover:bg-red-500/20">Retry</button>}</div>}

        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between"><span className="text-[9px] font-semibold uppercase tracking-[0.12em] text-muted-fg">Remediation loop</span><span className="text-[9px] text-muted-fg/70">Scan → Draft PR</span></div>
          <div className="grid grid-cols-4 gap-1.5">
          {STAGES.map((item, index) => {
            const currentIndex = STAGES.findIndex(candidate => candidate.id === stage);
            const active = item.id === stage;
            const complete = index < currentIndex;
            return <button key={item.id} onClick={() => setStage(item.id)} title={item.detail} className={`text-left rounded-lg border px-2 py-2 transition-colors ${active ? 'border-emerald-500/35 bg-emerald-500/10' : complete ? 'border-emerald-500/15 bg-emerald-500/[0.04]' : 'border-border bg-surface'}`}>
              <div className={`flex items-center gap-1 text-[10px] font-medium ${active || complete ? 'text-emerald-300' : 'text-muted-fg'}`}>{complete ? <CheckCircle2 size={11} /> : active ? <RefreshCw size={11} /> : <Circle size={10} />}{item.label}</div>
            </button>;
          })}
          </div>
        </div>

        <div className="mt-3 space-y-3">
          <section className="rounded-xl border border-border bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div><div className="text-xs font-semibold">Detection engines</div><div className="text-[10px] text-muted-fg mt-0.5">Choose the scanners that discover defects in this run.</div></div>
              <button onClick={() => void inspectScanners()} disabled={!connected || scannerBusy} className="rounded-lg p-1.5 text-muted-fg hover:bg-surface-2 hover:text-fg disabled:opacity-40" title="Refresh installed engines" aria-label="Refresh installed engines"><RefreshCw size={12} className={scannerBusy ? 'animate-spin' : ''} /></button>
            </div>
            {missingScanners.length > 0 && <div className="mx-3 mt-3 flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.07] px-3 py-2.5">
              <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-300"><Download size={11} /></span>
              <div className="min-w-0"><div className="text-[10px] font-medium text-amber-200">{missingScanners.length} coverage {missingScanners.length === 1 ? 'engine' : 'engines'} can be added</div><div className="mt-0.5 text-[9px] leading-relaxed text-muted-fg">Use the install icon below. Dvalin will run the command and verify the tool on PATH.</div></div>
            </div>}
            <div className="px-3 pb-3 pt-3 space-y-2">
              {scanners.map(scanner => {
                const Icon = scannerIcon(scanner);
                const selected = selectedScanners.has(scanner.id);
                const run = result?.scanners.find(item => item.id === scanner.id);
                return <div key={scanner.id} className={`rounded-lg border px-3 py-2.5 transition-colors ${scanner.available ? selected ? 'border-emerald-500/25 bg-emerald-500/[0.05]' : 'border-border bg-elevated/45' : 'border-border bg-elevated/35'}`}>
                  <div className="flex items-center gap-2.5">
                    <button disabled={!scanner.available} onClick={() => setSelectedScanners(previous => { const next = new Set(previous); if (next.has(scanner.id)) next.delete(scanner.id); else next.add(scanner.id); return next; })} className={`relative flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${scanner.available && selected ? 'bg-emerald-500/15 text-emerald-300' : 'bg-surface-2 text-muted-fg'} disabled:cursor-default`} title={scanner.available ? `${selected ? 'Disable' : 'Enable'} ${scanner.name}` : `${scanner.name} is not installed`}><Icon size={14} />{scanner.available && selected && <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-surface bg-emerald-500 text-black"><Check size={8} strokeWidth={3} /></span>}</button>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5"><span className="truncate text-[11px] font-medium">{scanner.name}</span>{scanner.id === 'builtin' && <span className="rounded bg-emerald-500/10 px-1 py-0.5 text-[7px] font-semibold uppercase text-emerald-300">core</span>}</div>
                      <div className="mt-0.5 truncate text-[9px] text-muted-fg">{scanner.description}</div>
                    </div>
                    {scanner.available ? <span className={`text-[8px] font-semibold uppercase ${run?.status === 'error' ? 'text-red-300' : selected ? 'text-emerald-300' : 'text-muted-fg'}`}>{run?.status === 'error' ? 'error' : selected ? run?.status ?? 'enabled' : 'off'}</span> : scanner.installCommand ? <button onClick={() => requestScannerInstall(scanner)} disabled={sending} className="group flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 disabled:opacity-40" title={`Install ${scanner.name}: ${scanner.installCommand}`} aria-label={`Install ${scanner.name}`}><Download size={12} className={installRequested === scanner.id && sending ? 'animate-bounce' : ''} /></button> : null}
                  </div>
                  {!scanner.available && scanner.installCommand && <div className="mt-2 flex items-center gap-1.5 border-t border-border/70 pt-2 text-[8px] text-muted-fg/70"><Terminal size={9} className="flex-shrink-0" /><code className="truncate">{scanner.installCommand}</code></div>}
                </div>;
              })}
              {scanners.length === 0 && <div className="px-4 py-6 text-xs text-muted-fg flex items-center justify-center gap-2"><Loader2 size={13} className="animate-spin" /> Inspecting detection engines…</div>}
            </div>
            {scanners.length > 0 && <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[9px] text-muted-fg"><span>{selectedScanners.size} of {availableScanners.length} installed enabled</span><span>{missingScanners.length ? `${missingScanners.length} optional missing` : 'Full engine coverage'}</span></div>}
          </section>

          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-start gap-2.5"><span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-300"><Wrench size={13} /></span><div><div className="text-xs font-semibold">Remediation toolchain</div><div className="mt-0.5 text-[10px] text-muted-fg">Dvalin coordinates coding and test tools after findings are validated.</div></div></div>
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              {REMEDIATION_CAPABILITIES.map(capability => {
                const Icon = capability.icon;
                return <div key={capability.label} className="rounded-lg border border-border/80 bg-elevated/50 px-2.5 py-2"><div className="flex items-center gap-1.5 text-[10px] font-medium"><Icon size={11} className="text-blue-300" />{capability.label}</div><div className="mt-1 text-[8px] text-muted-fg">{capability.detail}</div></div>;
              })}
            </div>
            <div className="mt-2.5 flex items-center gap-1.5 text-[8px] text-muted-fg/70"><Terminal size={9} /> Uses project-defined test/build commands and repository policy.</div>
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
