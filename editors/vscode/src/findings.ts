/**
 * Pure translation from a Dvalin scan result into editor-shaped findings.
 *
 * Nothing here imports `vscode`, so the banding and range arithmetic — the
 * parts that are actually easy to get wrong — are unit-testable without an
 * extension host.
 */

/** A finding as `dvalincode dvalin --json` emits it. */
export type DvalinFinding = {
  id: string;
  source: string;
  ruleId: string;
  ruleName?: string;
  severity: 'error' | 'warning' | 'note' | 'none';
  securitySeverity?: string;
  message: string;
  path: string;
  startLine?: number;
  endLine?: number;
  helpUri?: string;
  tags?: string[];
};

export type DvalinScanResult = {
  score: number;
  grade: string;
  findings: DvalinFinding[];
  scanners: { id: string; name: string; status: 'completed' | 'missing' | 'error'; error?: string }[];
  metrics: { critical: number; high: number; medium: number; low: number; files: number; rules: number };
  /** Present on the versioned verification contract. Older CLIs omit it. */
  coverage?: {
    status: 'complete' | 'partial' | 'unknown';
    scanners: Array<{ id: string; status: 'completed' | 'missing' | 'error' }>;
    exclusions: string[];
    deferred: string[];
    notes: string[];
  };
  gate?: {
    passed: boolean;
    mode: 'all' | 'new';
    threshold: 'critical' | 'high' | 'medium' | 'low' | 'none';
    considered: number;
  };
  workflowId?: string | null;
  schemaVersion?: number;
};

/** The CLI's own severity bands, mirrored so the squiggles agree with `--fail-on`. */
export type Band = 'critical' | 'high' | 'medium' | 'low';

/**
 * VS Code's DiagnosticSeverity values as plain numbers, so this module stays
 * free of the `vscode` import. A const object rather than a `const enum`:
 * esbuild cannot inline a const enum across modules. `extension.ts` maps these
 * onto the real enum explicitly instead of relying on the numbers lining up.
 */
export const Severity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;
export type Severity = (typeof Severity)[keyof typeof Severity];

/** Zero-based, half-open — the shape `vscode.Range` is built from. */
export type EditorRange = { startLine: number; startCharacter: number; endLine: number; endCharacter: number };

export type EditorFinding = {
  /** Workspace-relative, forward slashes. */
  path: string;
  range: EditorRange;
  severity: Severity;
  band: Band;
  message: string;
  ruleId: string;
  helpUri?: string;
  /** Carried through so a code action can address exactly this finding. */
  id: string;
};

/**
 * Mirrors `findingSeverity()` in src/commands/dvalin.ts. Kept in step
 * deliberately: a finding shown as an error in the editor must be the same one
 * `--fail-on high` would block in CI, or the two surfaces disagree about what
 * "high" means.
 */
export function bandOf(finding: DvalinFinding): Band {
  const score = Number.parseFloat(finding.securitySeverity ?? '');
  if (score >= 9) return 'critical';
  if (finding.severity === 'error' || score >= 7) return 'high';
  if (finding.severity === 'warning' || score >= 4) return 'medium';
  return 'low';
}

export function severityOf(band: Band): Severity {
  if (band === 'critical' || band === 'high') return Severity.Error;
  if (band === 'medium') return Severity.Warning;
  return Severity.Information;
}

/**
 * Dvalin reports 1-based lines and no columns. Highlight the whole line: the
 * end character is left large for the editor to clamp to the real line length.
 */
export function rangeOf(finding: DvalinFinding): EditorRange {
  const start = Math.max((finding.startLine ?? 1) - 1, 0);
  const end = Math.max((finding.endLine ?? finding.startLine ?? 1) - 1, start);
  return { startLine: start, startCharacter: 0, endLine: end, endCharacter: Number.MAX_SAFE_INTEGER };
}

export function toEditorFinding(finding: DvalinFinding): EditorFinding {
  const band = bandOf(finding);
  return {
    path: finding.path.split('\\').join('/'),
    range: rangeOf(finding),
    severity: severityOf(band),
    band,
    message: finding.ruleName ? `${finding.message} (${finding.ruleName})` : finding.message,
    ruleId: finding.ruleId,
    helpUri: finding.helpUri,
    id: finding.id,
  };
}

/** Group findings by file so each document's diagnostics can be set in one call. */
export function groupByPath(result: DvalinScanResult): Map<string, EditorFinding[]> {
  const grouped = new Map<string, EditorFinding[]>();
  for (const finding of result.findings) {
    const editorFinding = toEditorFinding(finding);
    const existing = grouped.get(editorFinding.path);
    if (existing) existing.push(editorFinding);
    else grouped.set(editorFinding.path, [editorFinding]);
  }
  return grouped;
}

/** Scanners the user asked for that were not on PATH, for a one-time notice. */
export function missingScanners(result: DvalinScanResult): string[] {
  return result.scanners.filter(scanner => scanner.status === 'missing').map(scanner => scanner.id);
}

export function summarize(result: DvalinScanResult): string {
  const total = result.findings.length;
  const coverage = coverageLabel(result);
  if (total === 0) {
    const claim = result.coverage?.status === 'complete' ? 'no actionable findings' : 'no findings in covered scope';
    return `Dvalin: ${claim} · ${coverage} (health ${result.score}/100 ${result.grade})`;
  }
  const { critical, high } = result.metrics;
  const worst = critical ? `${critical} critical` : high ? `${high} high` : `${total}`;
  return `Dvalin: ${total} finding${total === 1 ? '' : 's'} (${worst}) · ${coverage} — health ${result.score}/100 ${result.grade}`;
}

/** A compact label shared by status-bar, Problems, notifications, and tests. */
export function coverageLabel(result: Pick<DvalinScanResult, 'coverage'>): string {
  const status = result.coverage?.status ?? 'unknown';
  const scanners = result.coverage?.scanners ?? [];
  const completed = scanners.filter(scanner => scanner.status === 'completed').length;
  return scanners.length ? `coverage ${status} (${completed}/${scanners.length} engines)` : `coverage ${status}`;
}

/** Full evidence summary for the Dvalin output channel and status tooltip. */
export function verificationReport(result: DvalinScanResult): string {
  const lines = [summarize(result)];
  const coverage = result.coverage;
  if (coverage) {
    lines.push(`Coverage: ${coverage.status}`);
    if (coverage.scanners.length) {
      lines.push(`Engines: ${coverage.scanners.map(scanner => `${scanner.id}=${scanner.status}`).join(', ')}`);
    }
    for (const item of coverage.deferred) lines.push(`Deferred: ${item}`);
    for (const item of coverage.exclusions) lines.push(`Excluded: ${item}`);
    for (const item of coverage.notes) lines.push(`Note: ${item}`);
  } else {
    lines.push('Coverage: unknown (the CLI returned a legacy result without coverage evidence)');
  }
  if (result.gate) {
    lines.push(`Gate: ${result.gate.passed ? 'passed' : 'not passed'} · ${result.gate.mode} · threshold ${result.gate.threshold} · ${result.gate.considered} considered`);
  }
  if (result.workflowId) lines.push(`Workflow: ${result.workflowId}`);
  if (result.schemaVersion !== undefined) lines.push(`Schema: ${result.schemaVersion}`);
  return lines.join('\n');
}
