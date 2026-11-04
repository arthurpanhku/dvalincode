import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceRoot } from '../core/workspace.js';
import type { SecurityCoverageStatus } from '../security/contracts.js';
import { buildRemediationPrompt, normalizeSarifPath, readSnippet, type RemediationFinding } from './sarif.js';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_FINDINGS_BYTES = 64 * 1024 * 1024;
const MAX_COVERAGE_BYTES = 16 * 1024 * 1024;
const MAX_FINDINGS = 200;

type JsonObject = Record<string, unknown>;

type SealedArtifact = {
  path: string;
  sha256: string;
  mediaType?: string;
};

export type CodexSecurityCoverage = {
  status: SecurityCoverageStatus;
  mode?: string;
  includePaths: string[];
  excludePaths: string[];
  exclusions: string[];
  deferred: string[];
  openQuestions: string[];
  surfaces: Array<{ id: string; label: string; disposition: string }>;
  notes: string[];
};

export type CodexSecurityScanImport = {
  source: 'Codex Security';
  scanDirectory: string;
  manifestPath: string;
  findingsPath: string;
  coveragePath?: string;
  scan: {
    id: string;
    status: 'completed';
    sealedAt: string;
    producer: { name: string; version: string };
    mode?: string;
    target?: JsonObject;
  };
  integrity: {
    sealed: true;
    verifiedArtifacts: Array<{ path: string; sha256: string }>;
  };
  coverage: CodexSecurityCoverage;
  findings: RemediationFinding[];
  totalResults: number;
  skippedResults: number;
};

/**
 * Read a completed Codex Security scan through its documented portable
 * artifacts. This deliberately does not inspect Codex Security's private state
 * or invoke its model runtime: the sealed manifest is the handoff boundary.
 */
export async function importCodexSecurityScan(
  scanDirectory: string,
  workspace: string,
): Promise<CodexSecurityScanImport> {
  const root = await resolveWorkspaceRoot(workspace);
  const scanRoot = await realpath(path.resolve(scanDirectory)).catch(() => undefined);
  if (!scanRoot || !(await stat(scanRoot).catch(() => undefined))?.isDirectory()) {
    throw new Error(`Codex Security scan directory does not exist or is not a directory: ${path.resolve(scanDirectory)}`);
  }

  const manifestPath = path.join(scanRoot, 'scan-manifest.json');
  const manifestInfo = await lstat(manifestPath).catch(() => undefined);
  if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink()) {
    throw new Error(`Codex Security scan manifest is missing or not a regular file: ${manifestPath}`);
  }
  const manifest = await readJson(manifestPath, MAX_MANIFEST_BYTES, 'scan manifest');
  if (manifest.documentType !== 'codex-security.scan-manifest' || manifest.schemaVersion !== '1.0') {
    throw new Error('Unsupported Codex Security scan manifest; expected codex-security.scan-manifest schema 1.0');
  }
  const scan = objectAt(manifest, 'scan', 'Codex Security scan manifest');
  const scanId = requiredString(scan, 'id', 'Codex Security scan manifest');
  const status = requiredString(scan, 'status', 'Codex Security scan manifest');
  if (status !== 'completed') {
    throw new Error(`Codex Security scan ${scanId} is ${status}; only completed, sealed scans can be imported`);
  }
  const sealedAt = requiredString(scan, 'sealedAt', 'Codex Security scan manifest');
  const producerObject = objectAt(scan, 'producer', 'Codex Security scan manifest');
  const producer = {
    name: requiredString(producerObject, 'name', 'Codex Security producer'),
    version: requiredString(producerObject, 'version', 'Codex Security producer'),
  };
  const artifacts = parseArtifacts(scan.artifacts);
  const findingsRef = requiredString(scan, 'findingsRef', 'Codex Security scan manifest');
  const findingsArtifact = artifactFor(artifacts, findingsRef);
  const findingsFile = await verifyArtifact(scanRoot, findingsArtifact, MAX_FINDINGS_BYTES);
  const findingsDocument = parseJson(findingsFile.bytes, findingsFile.path, 'findings artifact');
  validateFindingsDocument(findingsDocument, scanId);

  const verifiedArtifacts = [{ path: findingsArtifact.path, sha256: findingsArtifact.sha256 }];
  let coverageDocument: JsonObject | undefined;
  let coveragePath: string | undefined;
  const coverageRef = optionalString(scan.coverageRef);
  if (coverageRef) {
    const coverageArtifact = artifactFor(artifacts, coverageRef);
    const coverageFile = await verifyArtifact(scanRoot, coverageArtifact, MAX_COVERAGE_BYTES);
    coverageDocument = parseJson(coverageFile.bytes, coverageFile.path, 'coverage artifact');
    validateCoverageDocument(coverageDocument, scanId);
    coveragePath = coverageFile.path;
    verifiedArtifacts.push({ path: coverageArtifact.path, sha256: coverageArtifact.sha256 });
  }

  const converted = await convertFindings(findingsDocument, root, scanId);
  return {
    source: 'Codex Security',
    scanDirectory: scanRoot,
    manifestPath,
    findingsPath: findingsFile.path,
    ...(coveragePath ? { coveragePath } : {}),
    scan: {
      id: scanId,
      status: 'completed',
      sealedAt,
      producer,
      ...(optionalString(scan.mode) ? { mode: optionalString(scan.mode) } : {}),
      ...(asObject(scan.target) ? { target: asObject(scan.target) } : {}),
    },
    integrity: { sealed: true, verifiedArtifacts },
    coverage: coverageFromArtifacts(scan, coverageDocument),
    findings: converted.findings,
    totalResults: converted.totalResults,
    skippedResults: converted.skippedResults,
  };
}

async function convertFindings(
  document: JsonObject,
  root: string,
  scanId: string,
): Promise<{ findings: RemediationFinding[]; totalResults: number; skippedResults: number }> {
  const rawFindings = document.findings as unknown[];
  const findings: RemediationFinding[] = [];
  let skippedResults = 0;

  for (const raw of rawFindings) {
    if (findings.length >= MAX_FINDINGS) {
      skippedResults += 1;
      continue;
    }
    const finding = asObject(raw);
    const locations = Array.isArray(finding?.locations) ? finding.locations : [];
    const location = asObject(locations[0]);
    const findingPath = await normalizeSarifPath(optionalString(location?.path), root);
    if (!finding || !findingPath) {
      skippedResults += 1;
      continue;
    }

    const severity = asObject(finding.severity);
    const level = optionalString(severity?.level) ?? 'medium';
    const findingId = requiredString(finding, 'findingId', 'Codex Security finding');
    const occurrenceId = optionalString(finding.occurrenceId);
    const ruleId = requiredString(finding, 'ruleId', 'Codex Security finding');
    const title = requiredString(finding, 'title', 'Codex Security finding');
    const summary = requiredString(finding, 'summary', 'Codex Security finding');
    const startLine = positiveInteger(location?.startLine);
    const endLine = positiveInteger(location?.endLine);
    const taxonomy = asObject(finding.taxonomy);
    const confidence = asObject(finding.confidence);
    const fingerprints = asObject(finding.fingerprints);
    const tags = uniqueStrings([
      'security',
      optionalString(taxonomy?.category),
      ...stringArray(taxonomy?.cwe),
      optionalString(confidence?.level) ? `confidence:${optionalString(confidence?.level)}` : undefined,
    ]);
    const snippet = await readSnippet(root, findingPath, startLine);
    const score = typeof severity?.score === 'number' && Number.isFinite(severity.score)
      ? String(severity.score)
      : scoreForLevel(level);
    const message = title === summary ? summary : `${title}: ${summary}`;
    const base = {
      id: occurrenceId ?? findingId,
      source: 'Codex Security',
      ruleId,
      ruleName: title,
      severity: sarifLevel(level),
      securitySeverity: score,
      message,
      path: findingPath,
      startLine,
      endLine,
      tags,
      snippet,
      external: {
        provider: 'codex-security',
        scanId,
        findingId,
        ...(occurrenceId ? { occurrenceId } : {}),
        ...(optionalString(fingerprints?.primary) ? { fingerprint: optionalString(fingerprints?.primary) } : {}),
      },
    } satisfies Omit<RemediationFinding, 'prompt'>;

    const guidance = optionalString(finding.remediation);
    const remediationTests = stringArray(finding.remediationTests);
    const evidence = [
      guidance ? `Codex Security remediation guidance: ${guidance}` : undefined,
      remediationTests.length ? `Suggested regression checks:\n${remediationTests.map(test => `- ${test}`).join('\n')}` : undefined,
    ].filter(Boolean).join('\n\n');
    findings.push({
      ...base,
      prompt: [buildRemediationPrompt(base), evidence].filter(Boolean).join('\n\n'),
    });
  }

  return { findings, totalResults: rawFindings.length, skippedResults };
}

function coverageFromArtifacts(scan: JsonObject, coverage: JsonObject | undefined): CodexSecurityCoverage {
  const scope = asObject(scan.scope);
  const review = asObject(scan.review);
  const includePaths = uniqueStrings([
    ...stringArray(scope?.includePaths),
    ...stringArray(coverage?.includePaths),
  ]);
  const excludePaths = uniqueStrings([
    ...stringArray(scope?.excludePaths),
    ...stringArray(review?.excludedPaths),
    ...stringArray(coverage?.excludePaths),
  ]);
  const explicitExclusions = Array.isArray(coverage?.explicitExclusions)
    ? coverage.explicitExclusions.map(asObject).filter(Boolean) as JsonObject[]
    : [];
  const exclusions = uniqueStrings([
    ...excludePaths.map(entry => `${entry} (path excluded)`),
    ...explicitExclusions.map(entry => {
      const pattern = optionalString(entry.pattern) ?? 'unspecified path';
      const reason = optionalString(entry.reason);
      return reason ? `${pattern} — ${reason}` : pattern;
    }),
  ]);
  const deferredEntries = Array.isArray(coverage?.deferred)
    ? coverage.deferred.map(asObject).filter(Boolean) as JsonObject[]
    : [];
  const surfaces = Array.isArray(coverage?.surfaces)
    ? coverage.surfaces.map(asObject).filter((surface): surface is JsonObject => Boolean(surface)).map(surface => ({
        id: optionalString(surface.id) ?? 'unknown',
        label: optionalString(surface.label) ?? optionalString(surface.id) ?? 'unknown',
        disposition: optionalString(surface.disposition) ?? 'unknown',
      }))
    : [];
  const openQuestionObjects = Array.isArray(coverage?.openQuestions)
    ? coverage.openQuestions.map(asObject).filter(Boolean) as JsonObject[]
    : [];
  const openQuestions = uniqueStrings(openQuestionObjects.map(entry => optionalString(entry.question)));
  const deferred = uniqueStrings([
    ...deferredEntries.map(entry => {
      const id = optionalString(entry.id);
      const reason = optionalString(entry.reason) ?? 'deferred';
      const paths = stringArray(entry.paths);
      return `${id ? `${id}: ` : ''}${reason}${paths.length ? ` (${paths.join(', ')})` : ''}`;
    }),
    ...surfaces.filter(surface => surface.disposition === 'needs_follow_up').map(surface => `${surface.label}: needs follow-up`),
    ...stringArray(scope?.limitations),
  ]);
  const notes = uniqueStrings([
    ...stringArray(scan.warnings),
    coverage ? undefined : 'The sealed scan did not include coverage.json; review scope is retained but completeness is unknown.',
    openQuestions.length ? `${openQuestions.length} open review question(s) remain.` : undefined,
  ]);

  let status: SecurityCoverageStatus;
  const declared = optionalString(coverage?.completeness);
  if (!coverage || declared === 'unknown') status = 'unknown';
  else if (declared === 'partial' || deferred.length || openQuestions.length) status = 'partial';
  else status = 'complete';

  return {
    status,
    mode: optionalString(coverage?.mode) ?? optionalString(scan.mode),
    includePaths,
    excludePaths,
    exclusions,
    deferred,
    openQuestions,
    surfaces,
    notes,
  };
}

function validateFindingsDocument(document: JsonObject, scanId: string): void {
  if (document.documentType !== 'codex-security.findings' || document.schemaVersion !== '1.0') {
    throw new Error('Unsupported Codex Security findings artifact; expected codex-security.findings schema 1.0');
  }
  if (document.scanId !== scanId) throw new Error('Codex Security findings scanId does not match the sealed manifest');
  if (!Array.isArray(document.findings)) throw new Error('Invalid Codex Security findings artifact: findings must be an array');
}

function validateCoverageDocument(document: JsonObject, scanId: string): void {
  if (document.documentType !== 'codex-security.coverage' || document.schemaVersion !== '1.0') {
    throw new Error('Unsupported Codex Security coverage artifact; expected codex-security.coverage schema 1.0');
  }
  if (document.scanId !== scanId) throw new Error('Codex Security coverage scanId does not match the sealed manifest');
}

function parseArtifacts(value: unknown): SealedArtifact[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Codex Security scan manifest has no sealed artifacts');
  return value.map((raw, index) => {
    const artifact = asObject(raw);
    if (!artifact) throw new Error(`Invalid sealed artifact at index ${index}`);
    const artifactPath = requiredString(artifact, 'path', `sealed artifact ${index}`);
    const sha256 = requiredString(artifact, 'sha256', `sealed artifact ${index}`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error(`Invalid SHA-256 for sealed artifact ${artifactPath}`);
    return { path: artifactPath, sha256, mediaType: optionalString(artifact.mediaType) };
  });
}

function artifactFor(artifacts: SealedArtifact[], reference: string): SealedArtifact {
  const matches = artifacts.filter(artifact => artifact.path === reference);
  if (matches.length !== 1) throw new Error(`Codex Security manifest must seal exactly one ${reference} artifact`);
  return matches[0]!;
}

async function verifyArtifact(
  scanRoot: string,
  artifact: SealedArtifact,
  maxBytes: number,
): Promise<{ path: string; bytes: Buffer }> {
  const artifactPath = await containedArtifactPath(scanRoot, artifact.path);
  const bytes = await readBytesWithLimit(artifactPath, maxBytes, `Codex Security artifact ${artifact.path}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.sha256) throw new Error(`Codex Security artifact hash mismatch: ${artifact.path}`);
  return { path: artifactPath, bytes };
}

async function containedArtifactPath(scanRoot: string, artifactPath: string): Promise<string> {
  if (!artifactPath || artifactPath.includes('\\') || artifactPath.includes('\0') || path.posix.isAbsolute(artifactPath)) {
    throw new Error(`Unsafe Codex Security artifact path: ${artifactPath}`);
  }
  const parts = artifactPath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe Codex Security artifact path: ${artifactPath}`);
  const candidate = path.resolve(scanRoot, ...parts);
  const relative = path.relative(scanRoot, candidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Codex Security artifact path: ${artifactPath}`);
  }
  const info = await lstat(candidate).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Codex Security artifact is missing or not a regular file: ${artifactPath}`);
  const canonical = await realpath(candidate);
  const canonicalRelative = path.relative(scanRoot, canonical);
  if (canonicalRelative === '..' || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw new Error(`Codex Security artifact escapes the scan directory: ${artifactPath}`);
  }
  return canonical;
}

async function readJson(file: string, maxBytes: number, label: string): Promise<JsonObject> {
  const bytes = await readBytesWithLimit(file, maxBytes, label);
  return parseJson(bytes, file, label);
}

async function readBytesWithLimit(file: string, maxBytes: number, label: string): Promise<Buffer> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Cannot read ${label}: ${file}`);
  if (info.size > maxBytes) throw new Error(`${label} exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB import limit: ${file}`);
  return readFile(file);
}

function parseJson(bytes: Buffer, file: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const object = asObject(value);
  if (!object) throw new Error(`Invalid ${label}: expected a JSON object`);
  return object;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function objectAt(parent: JsonObject, key: string, label: string): JsonObject {
  const value = asObject(parent[key]);
  if (!value) throw new Error(`Invalid ${label}: ${key} must be an object`);
  return value;
}

function requiredString(parent: JsonObject, key: string, label: string): string {
  const value = optionalString(parent[key]);
  if (!value) throw new Error(`Invalid ${label}: ${key} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function sarifLevel(level: string): RemediationFinding['severity'] {
  if (level === 'critical' || level === 'high') return 'error';
  if (level === 'medium') return 'warning';
  if (level === 'low' || level === 'informational') return 'note';
  return 'warning';
}

function scoreForLevel(level: string): string {
  if (level === 'critical') return '9.5';
  if (level === 'high') return '8.0';
  if (level === 'medium') return '5.0';
  if (level === 'low') return '2.0';
  return '0.0';
}
