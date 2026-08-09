import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { latestRun } from '../audit/log.js';
import { renderReport } from '../audit/report.js';
import type { CodePermissionMode } from '../agent/modes.js';
import {
  executeHarnessRun,
  type HarnessRunExecution,
  type HarnessRunHooks,
  type HarnessRunRequest,
} from '../harness/run.js';
import type { UnattendedPermissionMode } from '../core/policy.js';
import {
  runDvalinScanSuite,
  type DvalinScannerId,
  type DvalinScanSuiteResult,
} from '../remediation/scannerSuite.js';
import { readJournal, type JournalTurnEnd } from '../sessions/journal.js';
import { loadSession, type Session } from '../sessions/store.js';
import { VERSION } from '../version.js';

/**
 * Protocol revisions this server is known to speak, newest first. It exposes
 * tools and nothing else, and the tool lifecycle is unchanged across these
 * three, so all are honoured.
 *
 * The spec makes this a MUST: respond with the requested version when it is
 * supported, otherwise with one that is — echoing an arbitrary string claims
 * support for revisions this server has never implemented, and the client then
 * assumes features that are not there.
 */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const SCANNER_IDS: DvalinScannerId[] = ['builtin', 'semgrep', 'trivy', 'osv-scanner'];
/** Keeps a large scan from flooding the caller's context window. */
const DEFAULT_FINDING_LIMIT = 50;

type JsonRpcId = string | number | null;
type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

export type McpServerOptions = {
  cwd: string;
  workspaces: string[];
  maxPermissionMode: UnattendedPermissionMode;
};

export type McpServerDependencies = {
  executeRun: (request: HarnessRunRequest, hooks?: HarnessRunHooks) => Promise<HarnessRunExecution>;
  runScan: (cwd: string, options: { scanners?: DvalinScannerId[]; timeoutMs?: number }) => Promise<DvalinScanSuiteResult>;
  loadSession: (id: string) => Promise<Session | null>;
  renderReport: (runId: string) => string;
  latestRun: () => string | null;
};

export type DvalinMcpServer = {
  handleLine(line: string): Promise<JsonRpcResponse | null>;
};

const MCP_TOOLS = [
  {
    name: 'dvalin_scan',
    description:
      'Scan a workspace for injection, hardcoded secrets, XSS, dynamic code execution, and unsafe shell use. '
      + 'Deterministic and read-only: it runs no model, needs no credentials, and never edits files — safe to call '
      + 'after writing code. Returns findings with file, line, severity, and rule reference.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Workspace to scan. Defaults to the server workspace.' },
        scanners: {
          type: 'array',
          items: { type: 'string', enum: SCANNER_IDS },
          description: 'Defaults to builtin only, which needs nothing installed. The others are used when on PATH.',
        },
        limit: { type: 'integer', minimum: 1, description: `Maximum findings returned (default ${DEFAULT_FINDING_LIMIT}).` },
        timeout_seconds: { type: 'number', exclusiveMinimum: 0 },
        include_remediation_prompts: {
          type: 'boolean',
          description: 'Include the per-finding repair prompt. Verbose; off by default.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dvalin_run_task',
    description: 'Run a complete governed coding task inside DvalinCode. Long calls are expected; callers should use a generous timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        cwd: { type: 'string' },
        permission_mode: { type: 'string', enum: ['plan', 'auto', 'bypass'] },
        session_id: { type: 'string' },
        max_iterations: { type: 'integer', minimum: 1 },
        timeout_minutes: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'dvalin_get_session',
    description: 'Get a durable DvalinCode session summary and its latest audit anchor.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dvalin_get_evidence',
    description: 'Render the Markdown audit evidence for a DvalinCode run (defaults to the latest run).',
    inputSchema: {
      type: 'object',
      properties: { run_id: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
] as const;

export async function createMcpServer(
  options: McpServerOptions,
  overrides: Partial<McpServerDependencies> = {},
): Promise<DvalinMcpServer> {
  const deps: McpServerDependencies = {
    executeRun: executeHarnessRun,
    runScan: runDvalinScanSuite,
    loadSession,
    renderReport: runId => renderReport(runId),
    latestRun: () => latestRun(),
    ...overrides,
  };
  const serverCwd = await realpath(path.resolve(options.cwd));
  const allowedWorkspaces = await Promise.all(options.workspaces.map(workspace => realpath(path.resolve(workspace))));

  const handleLine = async (line: string): Promise<JsonRpcResponse | null> => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, 'Parse error');
    }
    if (!isRequest(request)) return rpcError(requestId(request), -32600, 'Invalid Request');
    if (request.id === undefined) return null;

    if (request.method === 'initialize') {
      const requestedVersion = asRecord(request.params)?.protocolVersion;
      return rpcResult(request.id, {
        protocolVersion: negotiateProtocolVersion(requestedVersion),
        capabilities: { tools: {} },
        serverInfo: { name: 'dvalincode', version: VERSION },
      });
    }
    if (request.method === 'tools/list') {
      return rpcResult(request.id, { tools: MCP_TOOLS });
    }
    if (request.method === 'tools/call') {
      const params = asRecord(request.params);
      if (!params || typeof params.name !== 'string') return rpcError(request.id, -32602, 'Invalid params');
      const args = asRecord(params.arguments) ?? {};
      try {
        const result = await callTool(params.name, args, {
          deps,
          serverCwd,
          allowedWorkspaces,
          maxPermissionMode: options.maxPermissionMode,
        });
        return rpcResult(request.id, result);
      } catch (err) {
        return rpcResult(request.id, toolResult(err instanceof Error ? err.message : String(err), true));
      }
    }
    return rpcError(request.id, -32601, 'Method not found');
  };

  return { handleLine };
}

export async function runMcpStdio(
  options: McpServerOptions,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const server = await createMcpServer(options);
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const response = await server.handleLine(line);
    if (response) io.output.write(JSON.stringify(response) + '\n');
  }
}

/** Requested version when supported; otherwise the newest this server speaks. */
export function negotiateProtocolVersion(requested: unknown): string {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested as never)
    ? (requested as string)
    : LATEST_PROTOCOL_VERSION;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  context: {
    deps: McpServerDependencies;
    serverCwd: string;
    allowedWorkspaces: string[];
    maxPermissionMode: UnattendedPermissionMode;
  },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (name === 'dvalin_scan') {
    const cwd = args.cwd === undefined ? context.serverCwd : requireString(args.cwd, 'cwd');
    const resolvedCwd = await resolveAllowedWorkspace(cwd, context.allowedWorkspaces);
    const scanners = optionalScannerIds(args.scanners);
    const limit = optionalPositiveNumber(args.limit, 'limit', true) ?? DEFAULT_FINDING_LIMIT;
    const timeoutSeconds = optionalPositiveNumber(args.timeout_seconds, 'timeout_seconds', false);
    const includePrompts = args.include_remediation_prompts === true;

    const result = await context.deps.runScan(resolvedCwd, {
      scanners,
      timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
    });

    // Trimmed by default: the per-finding repair prompt and source snippet are
    // ~1KB each, and a caller that wants context can read the file itself.
    const findings = result.findings.slice(0, limit).map(finding => ({
      ruleId: finding.ruleId,
      ruleName: finding.ruleName,
      severity: finding.severity,
      securitySeverity: finding.securitySeverity,
      message: finding.message,
      path: finding.path,
      startLine: finding.startLine,
      endLine: finding.endLine,
      helpUri: finding.helpUri,
      tags: finding.tags,
      ...(includePrompts ? { prompt: finding.prompt } : {}),
    }));

    return toolResult(JSON.stringify({
      score: result.score,
      grade: result.grade,
      metrics: result.metrics,
      totalFindings: result.findings.length,
      returnedFindings: findings.length,
      findings,
      scanners: result.scanners.map(scanner => ({
        id: scanner.id,
        status: scanner.status,
        findings: scanner.findings,
        ...(scanner.error ? { error: scanner.error } : {}),
      })),
    }));
  }

  if (name === 'dvalin_run_task') {
    const prompt = requireString(args.prompt, 'prompt');
    if (!prompt.trim()) throw new Error('prompt must not be empty');
    const cwd = args.cwd === undefined ? context.serverCwd : requireString(args.cwd, 'cwd');
    const resolvedCwd = await resolveAllowedWorkspace(cwd, context.allowedWorkspaces);
    const permissionMode = optionalPermissionMode(args.permission_mode);
    const sessionId = optionalString(args.session_id, 'session_id');
    const maxIterations = optionalPositiveNumber(args.max_iterations, 'max_iterations', true);
    const timeoutMinutes = optionalPositiveNumber(args.timeout_minutes, 'timeout_minutes', false);

    const execution = await context.deps.executeRun({
      content: prompt,
      cwd: resolvedCwd,
      sessionId,
      mode: 'code',
      permissionMode: permissionMode as CodePermissionMode | undefined,
      maxIterations,
      timeoutMinutes,
      maxPermissionMode: context.maxPermissionMode,
      unattended: true,
      origin: 'mcp-serve',
    });
    return toolResult(JSON.stringify(execution.result), execution.exitCode !== 0);
  }

  if (name === 'dvalin_get_session') {
    const sessionId = requireString(args.session_id, 'session_id');
    const session = await context.deps.loadSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await resolveAllowedWorkspace(session.cwd, context.allowedWorkspaces);
    const latest = [...readJournal(session.id)].reverse().find(
      (entry): entry is JournalTurnEnd & { seq: number; ts: string } =>
        entry.type === 'turn_end' && !!(entry.runId || entry.auditHead),
    );
    return toolResult(JSON.stringify({
      sessionId: session.id,
      cwd: session.cwd,
      summary: session.summary ?? '',
      messageCount: session.messages.length,
      runId: latest?.runId,
      auditHead: latest?.auditHead,
    }));
  }

  if (name === 'dvalin_get_evidence') {
    const requestedRunId = optionalString(args.run_id, 'run_id');
    const runId = requestedRunId ?? context.deps.latestRun();
    if (!runId) throw new Error('No audit runs found.');
    return toolResult(context.deps.renderReport(runId));
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function resolveAllowedWorkspace(candidate: string, allowed: string[]): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(candidate));
  } catch {
    throw new Error(`Workspace does not exist: ${path.resolve(candidate)}`);
  }
  const permitted = allowed.some(root => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
  });
  if (!permitted) throw new Error(`cwd is outside the mcp-serve workspace allowlist: ${resolved}`);
  return resolved;
}

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string';
}

function requestId(value: unknown): JsonRpcId {
  const id = asRecord(value)?.id;
  return typeof id === 'string' || typeof id === 'number' || id === null ? id : null;
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalPermissionMode(value: unknown): UnattendedPermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === 'plan' || value === 'auto' || value === 'bypass') return value;
  throw new Error('permission_mode must be plan, auto, or bypass');
}

/**
 * Omitted means `builtin` only — the one engine that needs nothing installed,
 * so the default call works on any machine without prior setup.
 */
function optionalScannerIds(value: unknown): DvalinScannerId[] {
  if (value === undefined) return ['builtin'];
  if (!Array.isArray(value)) throw new Error('scanners must be an array');
  const unknown = value.filter(id => !SCANNER_IDS.includes(id as DvalinScannerId));
  if (unknown.length) throw new Error(`Unknown scanner(s): ${unknown.join(', ')}. Choose from ${SCANNER_IDS.join(', ')}.`);
  if (!value.length) throw new Error('scanners must not be empty');
  return [...new Set(value as DvalinScannerId[])];
}

function optionalPositiveNumber(value: unknown, field: string, integer: boolean): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${field} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}
