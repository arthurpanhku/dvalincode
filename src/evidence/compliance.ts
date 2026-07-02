import type { EvidencePack } from './pack.js';

/**
 * A reviewer's bridge from DvalinCode's runtime controls to the compliance
 * frameworks the project already tracks (docs/security/OPENSSF-SCORECARD.md,
 * docs/governance/ISO-42001-AIMS.md). Each entry names a control, the pack
 * section that *backs* it with real data, and the clause it maps to. The pack
 * marks a control `backed: true` only when that section actually contains
 * evidence in this export — we never fabricate coverage.
 */
export type ComplianceControl = {
  id: string;
  control: string;
  section: 'policy' | 'trust' | 'runs';
  openssf?: string;
  iso42001?: string;
};

export const COMPLIANCE_CONTROLS: ComplianceControl[] = [
  {
    id: 'org-policy-narrowing',
    control: 'Agent authority is bounded by an org policy resolved by narrowing (a repo source can only tighten the machine source).',
    section: 'policy',
    openssf: 'Least-privilege / access control',
    iso42001: 'A.5 policies for AI; A.9 use limitation',
  },
  {
    id: 'policy-integrity',
    control: 'The governing policy is content-hashed; each run records the hash it ran under.',
    section: 'policy',
    iso42001: 'A.6 change management; A.8 records of processing',
  },
  {
    id: 'network-egress-enforcement',
    control: 'Outbound network is enforced per boundary (provider, shell/subprocess, MCP) and fails closed where isolation is unavailable.',
    section: 'trust',
    openssf: 'Network egress control',
    iso42001: 'A.9 operational controls',
  },
  {
    id: 'self-verifiable-posture',
    control: 'The install can emit its own live security posture for independent verification (dvalincode trust).',
    section: 'trust',
    iso42001: 'A.7 transparency; Clause 9 monitoring',
  },
  {
    id: 'tamper-evident-audit',
    control: 'Every agent run produces a hash-chained audit log whose integrity is verifiable after the fact.',
    section: 'runs',
    openssf: 'Tamper-evident logging',
    iso42001: 'A.8 records; Clause 9.2 audit',
  },
  {
    id: 'audit-minimization',
    control: 'Audit records are minimized — no prompts, file contents, shell arguments, or credentials are persisted.',
    section: 'runs',
    iso42001: 'A.9 data minimization; privacy by design',
  },
];

export type ComplianceEntry = ComplianceControl & { backed: boolean };

/** Mark each control backed/unbacked by what this specific pack actually contains. */
export function evaluateCompliance(pack: Omit<EvidencePack, 'compliance' | 'manifest'>): ComplianceEntry[] {
  return COMPLIANCE_CONTROLS.map(c => ({ ...c, backed: isBacked(c, pack) }));
}

function isBacked(c: ComplianceControl, pack: Omit<EvidencePack, 'compliance' | 'manifest'>): boolean {
  switch (c.section) {
    case 'policy':
      return Boolean(pack.policy?.hash);
    case 'trust':
      return Boolean(pack.trust);
    case 'runs':
      // Backed only when at least one run's chain is present and verified.
      return pack.runs.length > 0 && pack.runs.every(r => r.verify.ok);
  }
}
