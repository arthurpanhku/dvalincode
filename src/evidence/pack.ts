import { sha256, canonicalJSON } from '../audit/hash.js';
import {
  defaultAuditDir,
  listRuns,
  readRecords,
  verifyRecords,
  type AuditRecord,
  type RunMeta,
  type VerifyResult,
} from '../audit/log.js';
import { loadPolicy, type PolicySource, type ResolvedPolicy } from '../core/policy.js';
import { buildTrustReport, type TrustReport } from '../core/trust.js';
import { readJournal } from '../sessions/journal.js';
import { evaluateCompliance, type ComplianceEntry } from './compliance.js';

export const EVIDENCE_SCHEMA = 'dvalincode-evidence/v1';

export type EvidenceRun = {
  runId: string;
  meta: RunMeta | null;
  records: AuditRecord[];
  verify: VerifyResult;
  /** Link to the originating session turn, when the run recorded a sessionId. */
  journalAnchor?: { sessionId: string; messageId: string; auditHead?: string };
};

export type EvidencePack = {
  schema: typeof EVIDENCE_SCHEMA;
  generatedAt: string;
  tool: { name: 'dvalincode'; version: string };
  policy: { resolved: ResolvedPolicy; sources: PolicySource[]; hash: string };
  trust: TrustReport;
  runs: EvidenceRun[];
  compliance: ComplianceEntry[];
  manifest: { sections: Record<string, string>; bundleHash: string };
};

export type BuildOptions = {
  cwd?: string;
  auditDir?: string;
  sessionsDir?: string;
  /** Explicit run ids; otherwise the newest `last` runs are included. */
  runIds?: string[];
  last?: number;
};

/** Assemble an Evidence Pack from the install's current policy, posture, and audit runs. */
export function buildEvidencePack(opts: BuildOptions = {}): EvidencePack {
  const cwd = opts.cwd ?? process.cwd();
  const auditDir = opts.auditDir ?? defaultAuditDir();
  const loaded = loadPolicy(cwd);
  const trust = buildTrustReport(cwd);

  const ids = opts.runIds ?? listRuns(auditDir).slice(0, opts.last ?? 10);
  const runs: EvidenceRun[] = ids.map(runId => {
    let records: AuditRecord[] = [];
    let verify: VerifyResult;
    try {
      records = readRecords(runId, auditDir);
      verify = verifyRecords(runId, records);
    } catch (err) {
      verify = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    const start = records.find(r => r.type === 'run_start');
    const meta = start && start.type === 'run_start' ? stripType(start) : null;
    return { runId, meta, records, verify, journalAnchor: findAnchor(meta, runId, opts.sessionsDir) };
  });

  const core = {
    schema: EVIDENCE_SCHEMA as typeof EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    tool: { name: 'dvalincode' as const, version: trust.version },
    policy: { resolved: loaded.policy, sources: loaded.sources, hash: loaded.hash },
    trust,
    runs,
  };
  const compliance = evaluateCompliance(core);
  const withCompliance = { ...core, compliance };
  return { ...withCompliance, manifest: buildManifest(withCompliance) };
}

export type VerifyReport = {
  ok: boolean;
  bundleHashOk: boolean;
  sectionIssues: string[];
  runIssues: string[];
  minimizationIssues: string[];
};

/** Re-derive every hash and re-run each embedded chain — fully offline. */
export function verifyEvidencePack(pack: EvidencePack): VerifyReport {
  const sectionIssues: string[] = [];
  const runIssues: string[] = [];

  const expected = manifestSections(stripManifest(pack));
  for (const [name, hash] of Object.entries(expected)) {
    if (pack.manifest.sections[name] !== hash) sectionIssues.push(`section "${name}" hash mismatch`);
  }
  for (const name of Object.keys(pack.manifest.sections)) {
    if (!(name in expected)) sectionIssues.push(`manifest lists unknown section "${name}"`);
  }

  const bundleHashOk = pack.manifest.bundleHash === sha256(canonicalJSON(stripBundleHash(pack)));
  if (!bundleHashOk) sectionIssues.push('bundle hash mismatch');

  for (const run of pack.runs) {
    const result = verifyRecords(run.runId, run.records);
    if (!result.ok) runIssues.push(`run ${run.runId}: ${result.reason ?? `broken at seq ${result.brokenAtSeq}`}`);
  }

  const minimizationIssues = scanForSecrets(pack);

  return {
    ok: sectionIssues.length === 0 && bundleHashOk && runIssues.length === 0 && minimizationIssues.length === 0,
    bundleHashOk,
    sectionIssues,
    runIssues,
    minimizationIssues,
  };
}

// ── internals ────────────────────────────────────────────────────────────────

function stripType<T extends { type: unknown }>(record: T): Omit<T, 'type'> {
  const { type: _drop, seq: _seq, ts: _ts, prevHash: _prev, ...rest } = record as T & {
    seq?: unknown;
    ts?: unknown;
    prevHash?: unknown;
  };
  return rest as Omit<T, 'type'>;
}

function findAnchor(meta: RunMeta | null, runId: string, sessionsDir?: string): EvidenceRun['journalAnchor'] {
  const sessionId = meta?.sessionId;
  if (!sessionId) return undefined;
  const end = readJournal(sessionId, sessionsDir).find(
    r => r.type === 'turn_end' && r.runId === runId,
  );
  if (!end || end.type !== 'turn_end') return { sessionId, messageId: '(unknown)' };
  return { sessionId, messageId: end.messageId, auditHead: end.auditHead };
}

type CoreSections = Omit<EvidencePack, 'manifest'>;

/** Per-section SHA-256 of the meaningful sections (excludes the manifest itself). */
function manifestSections(core: CoreSections): Record<string, string> {
  return {
    header: sha256(canonicalJSON({ schema: core.schema, generatedAt: core.generatedAt, tool: core.tool })),
    policy: sha256(canonicalJSON(core.policy)),
    trust: sha256(canonicalJSON(core.trust)),
    runs: sha256(canonicalJSON(core.runs)),
    compliance: sha256(canonicalJSON(core.compliance)),
  };
}

function buildManifest(core: CoreSections): EvidencePack['manifest'] {
  const sections = manifestSections(core);
  return { sections, bundleHash: sha256(canonicalJSON(core)) };
}

function stripManifest(pack: EvidencePack): CoreSections {
  const { manifest: _m, ...core } = pack;
  return core;
}

function stripBundleHash(pack: EvidencePack): CoreSections {
  return stripManifest(pack);
}

const SECRET_KEY = /^(authorization|api[-_]?key|apikey|password|secret|token|bearer)$/i;

/** Structural minimization guard: flag any key that looks like a credential with a non-empty value. */
function scanForSecrets(value: unknown, path = ''): string[] {
  const issues: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => issues.push(...scanForSecrets(v, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && typeof v === 'string' && v.length > 0) {
        issues.push(`possible secret at ${path}.${key}`);
      }
      issues.push(...scanForSecrets(v, path ? `${path}.${key}` : key));
    }
  }
  return issues;
}
