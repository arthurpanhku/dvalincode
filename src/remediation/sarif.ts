import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveInsideWorkspace } from '../core/workspace.js';

type SarifArtifactLocation = {
  uri?: string;
  uriBaseId?: string;
};

type SarifRegion = {
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
};

type SarifLocation = {
  physicalLocation?: {
    artifactLocation?: SarifArtifactLocation;
    region?: SarifRegion;
  };
  message?: {
    text?: string;
  };
};

type SarifResult = {
  ruleId?: string;
  level?: string;
  message?: {
    text?: string;
  };
  locations?: SarifLocation[];
  partialFingerprints?: Record<string, string>;
  fingerprints?: Record<string, string>;
};

type SarifRule = {
  id?: string;
  name?: string;
  shortDescription?: {
    text?: string;
  };
  fullDescription?: {
    text?: string;
  };
  helpUri?: string;
  properties?: {
    tags?: string[];
    precision?: string;
    problem?: {
      severity?: string;
    };
    security_severity?: string;
  };
};

type SarifRun = {
  tool?: {
    driver?: {
      name?: string;
      rules?: SarifRule[];
    };
  };
  results?: SarifResult[];
};

type SarifLog = {
  version?: string;
  runs?: SarifRun[];
};

export type RemediationFinding = {
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
  tags: string[];
  snippet?: string;
  prompt: string;
};

export type SarifImportResult = {
  source: string;
  findings: RemediationFinding[];
  totalResults: number;
  skippedResults: number;
};

const MAX_FINDINGS = 200;
const CONTEXT_RADIUS = 4;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stableFindingId(parts: string[]): string {
  return parts
    .join(':')
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

function ruleMap(run: SarifRun): Map<string, SarifRule> {
  const rules = new Map<string, SarifRule>();
  for (const rule of run.tool?.driver?.rules ?? []) {
    if (rule.id) rules.set(rule.id, rule);
  }
  return rules;
}

function normalizeLevel(level?: string): RemediationFinding['severity'] {
  if (level === 'error' || level === 'warning' || level === 'note' || level === 'none') return level;
  return 'warning';
}

function normalizeSarifPath(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const trimmed = uri.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.startsWith('http:') || trimmed.startsWith('https:')) {
    return undefined;
  }

  const withoutFileScheme = trimmed.startsWith('file://')
    ? trimmed.replace(/^file:\/+/, '/')
    : trimmed;
  const decoded = decodeURIComponent(withoutFileScheme);
  return path.normalize(decoded).replace(/\\/g, '/');
}

async function readSnippet(cwd: string | undefined, findingPath: string, startLine: number | undefined): Promise<string | undefined> {
  if (!cwd || !startLine || path.isAbsolute(findingPath)) return undefined;
  try {
    const resolved = await resolveInsideWorkspace(cwd, findingPath);
    const lines = (await readFile(resolved, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, startLine - CONTEXT_RADIUS);
    const end = Math.min(lines.length, startLine + CONTEXT_RADIUS);
    return lines
      .slice(start - 1, end)
      .map((line, index) => `${String(start + index).padStart(4, ' ')} | ${line}`)
      .join('\n');
  } catch {
    return undefined;
  }
}

export function buildRemediationPrompt(finding: Omit<RemediationFinding, 'prompt'>): string {
  const location = `${finding.path}${finding.startLine ? `:${finding.startLine}` : ''}`;
  const tags = finding.tags.length > 0 ? finding.tags.join(', ') : 'none';
  const snippet = finding.snippet
    ? `\nRelevant source context:\n\`\`\`\n${finding.snippet}\n\`\`\`\n`
    : '\nNo source snippet was available. Read the target file before editing.\n';

  return [
    'Secure remediation task:',
    '',
    `Tool: ${finding.source}`,
    `Rule: ${finding.ruleId}${finding.ruleName ? ` (${finding.ruleName})` : ''}`,
    `Severity: ${finding.securitySeverity ?? finding.severity}`,
    `Location: ${location}`,
    `Tags: ${tags}`,
    finding.helpUri ? `Reference: ${finding.helpUri}` : undefined,
    '',
    'Finding:',
    finding.message,
    snippet,
    'Instructions:',
    '1. Inspect the affected code and any directly related callers/tests before editing.',
    '2. Apply the smallest safe fix that removes the vulnerability class, not just the symptom.',
    '3. Preserve existing behavior unless the vulnerable behavior must change.',
    '4. Run the most relevant tests or type checks available in this project.',
    '5. Return a remediation report with changed files, verification commands, remaining risk, and PR-ready summary.',
  ].filter(Boolean).join('\n');
}

export async function parseSarifForRemediation(report: unknown, opts: { cwd?: string } = {}): Promise<SarifImportResult> {
  const root = asObject(report);
  if (!root || !Array.isArray(root.runs)) {
    throw new Error('Invalid SARIF report: expected a top-level runs array');
  }

  const sarif = root as SarifLog;
  const findings: RemediationFinding[] = [];
  let totalResults = 0;
  let skippedResults = 0;

  for (const [runIndex, run] of (sarif.runs ?? []).entries()) {
    const source = run.tool?.driver?.name ?? 'SARIF';
    const rules = ruleMap(run);

    for (const [resultIndex, result] of (run.results ?? []).entries()) {
      totalResults += 1;
      if (findings.length >= MAX_FINDINGS) {
        skippedResults += 1;
        continue;
      }

      const location = result.locations?.[0];
      const physical = location?.physicalLocation;
      const findingPath = normalizeSarifPath(physical?.artifactLocation?.uri);
      if (!findingPath) {
        skippedResults += 1;
        continue;
      }

      const ruleId = result.ruleId ?? 'unknown-rule';
      const rule = rules.get(ruleId);
      const startLine = physical?.region?.startLine;
      const endLine = physical?.region?.endLine;
      const snippet = await readSnippet(opts.cwd, findingPath, startLine);
      const fingerprint = result.partialFingerprints?.primaryLocationLineHash
        ?? result.partialFingerprints?.primaryLocationStartColumnFingerprint
        ?? result.fingerprints?.primaryLocationLineHash
        ?? `${runIndex}-${resultIndex}`;

      const baseFinding = {
        id: stableFindingId([source, ruleId, findingPath, String(startLine ?? 0), fingerprint]),
        source,
        ruleId,
        ruleName: rule?.name ?? rule?.shortDescription?.text,
        severity: normalizeLevel(result.level),
        securitySeverity: rule?.properties?.security_severity ?? rule?.properties?.problem?.severity,
        message: result.message?.text ?? location?.message?.text ?? rule?.fullDescription?.text ?? 'Security finding',
        path: findingPath,
        startLine,
        endLine,
        helpUri: rule?.helpUri,
        tags: rule?.properties?.tags ?? [],
        snippet,
      } satisfies Omit<RemediationFinding, 'prompt'>;

      findings.push({
        ...baseFinding,
        prompt: buildRemediationPrompt(baseFinding),
      });
    }
  }

  return {
    source: findings[0]?.source ?? 'SARIF',
    findings,
    totalResults,
    skippedResults,
  };
}
