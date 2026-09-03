import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runAgentTurn } from '../agent/session.js';
import { DEFAULT_TURN_CONFIG, type AgentEvent, type TurnConfig } from '../agent/types.js';
import type { AgentMode, CodePermissionMode } from '../agent/modes.js';
import type { RunOrigin } from '../audit/log.js';
import {
  loadPolicy,
  narrowerUnattendedPermissionMode,
  PolicyViolationError,
  unattendedPermissionAllowed,
  type UnattendedPermissionMode,
} from '../core/policy.js';
import { loadSession } from '../sessions/store.js';
import { createVerificationCollector, type HarnessVerification } from './verification.js';

export const DEFAULT_RUN_TIMEOUT_MINUTES = 25;

export type HarnessStopReason = 'done' | 'max_iterations' | 'timeout' | 'interrupted' | 'error';

export type HarnessRunResult = {
  ok: boolean;
  sessionId?: string;
  runId?: string;
  auditHead?: string;
  policyHash?: string;
  provider?: string;
  model?: string;
  iterationsUsed: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  wallSeconds: number;
  output: string;
  stopReason: HarnessStopReason;
  error?: string;
  /**
   * What the turn's security scanning covered, and any Verified Fix Record it
   * filed. Absent when the turn did neither — which is deliberately different
   * from a scan whose coverage came back `unknown`. A consumer that cannot tell
   * "nothing was scanned" from "the scan could not say what it looked at" is
   * back to the problem this field exists to solve.
   *
   * It does not affect `exitCode`. Coverage describes the scan, not the run:
   * a turn that completed its task with a half-blind scanner did not fail, and
   * folding that into the process exit would silently change a documented
   * contract for every existing consumer. The status is reported so a caller
   * can gate on it deliberately.
   */
  verification?: HarnessVerification;
};

export type HarnessRunRequest = {
  content: string;
  cwd: string;
  sessionId?: string;
  mode?: AgentMode;
  permissionMode?: CodePermissionMode;
  provider?: string;
  model?: string;
  profile?: string;
  maxIterations?: number;
  maxToolCalls?: number;
  timeoutMinutes?: number;
  reportFile?: string;
  unattended?: boolean;
  /** Additional ceiling imposed by a transport such as mcp-serve. */
  maxPermissionMode?: UnattendedPermissionMode;
  origin?: RunOrigin;
  signal?: AbortSignal;
};

export type HarnessRunHooks = {
  onEvent?: (event: AgentEvent) => void;
  onProviderSelected?: (provider: string, model: string) => void;
  onRunStart?: (event: {
    type: 'run_start';
    sessionId: string;
    runId: string;
    provider: string;
    model: string;
    policyHash: string;
  }) => void;
};

export type HarnessRunExecution = {
  result: HarnessRunResult;
  exitCode: 0 | 1 | 2 | 3 | 4;
  reportMarkdown?: string;
};

/** A caller error that maps to the documented deterministic usage exit code. */
export class HarnessUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessUsageError';
  }
}

/**
 * Execute one bounded, non-interactive governed turn. This is the shared
 * primitive used by both `dvalincode run` and the task-level MCP server.
 */
export async function executeHarnessRun(
  request: HarnessRunRequest,
  hooks: HarnessRunHooks = {},
): Promise<HarnessRunExecution> {
  const startedAt = Date.now();
  let sessionId = request.sessionId;
  let runId: string | undefined;
  let policyHash: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let toolCalls = 0;
  let iterationsUsed = 0;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let output = '';
  let verificationCollector: ReturnType<typeof createVerificationCollector> | undefined;

  const finish = (
    exitCode: HarnessRunExecution['exitCode'],
    stopReason: HarnessStopReason,
    error?: string,
    auditHead?: string,
  ): HarnessRunExecution => {
    // Collected on every exit path, not only the successful one: a turn that
    // scanned and then timed out still learned something about coverage, and
    // dropping it would hide the scan precisely when the run needs explaining.
    //
    // Guarded because this runs inside the catch path too. A field that reports
    // on the run must never be able to fail the run, or replace the error that
    // actually ended it with one from the reporting itself.
    let collected: HarnessVerification | undefined;
    try {
      collected = verificationCollector?.collect();
    } catch {
      collected = undefined;
    }
    return {
      exitCode,
      result: {
        ok: exitCode === 0,
        sessionId,
        runId,
        auditHead,
        policyHash,
        provider,
        model,
        iterationsUsed,
        toolCalls,
        usage,
        wallSeconds: (Date.now() - startedAt) / 1000,
        output,
        stopReason,
        ...(error ? { error } : {}),
        ...(collected ? { verification: collected } : {}),
      },
    };
  };

  let timeoutSignal: AbortSignal | undefined;
  try {
    validatePositiveNumber(request.maxIterations, 'max iterations', true);
    validatePositiveNumber(request.maxToolCalls, 'max tool calls', true);
    validatePositiveNumber(request.timeoutMinutes, 'timeout', false);
    if (!request.content.trim()) throw new HarnessUsageError('Prompt must not be empty.');
    if (request.permissionMode === 'ask') {
      throw new HarnessUsageError('Permission mode "ask" is interactive and cannot be used with a headless run.');
    }

    const cwd = path.resolve(request.cwd);
    let cwdStat;
    try {
      cwdStat = await stat(cwd);
    } catch {
      throw new HarnessUsageError(`Working directory does not exist: ${cwd}`);
    }
    if (!cwdStat.isDirectory()) throw new HarnessUsageError(`Working directory is not a directory: ${cwd}`);

    if (request.sessionId) {
      let session;
      try {
        session = await loadSession(request.sessionId);
      } catch (err) {
        throw new HarnessUsageError(err instanceof Error ? err.message : String(err));
      }
      if (!session) throw new HarnessUsageError(`Session not found: ${request.sessionId}`);
    }

    const loadedPolicy = loadPolicy(cwd);
    policyHash = loadedPolicy.hash;

    const requestedPermission = request.permissionMode as UnattendedPermissionMode | undefined;
    const policyCeiling = request.unattended ? loadedPolicy.policy.unattended.maxPermissionMode : undefined;
    const permissionCeiling = narrowerUnattendedPermissionMode(request.maxPermissionMode, policyCeiling);
    if (requestedPermission && permissionCeiling && !unattendedPermissionAllowed(requestedPermission, permissionCeiling)) {
      throw new PolicyViolationError(
        'unattended',
        `permission mode "${requestedPermission}" exceeds unattended ceiling "${permissionCeiling}"`,
        requestedPermission,
      );
    }
    let permissionMode: CodePermissionMode = request.permissionMode ?? 'auto';
    if (
      !request.permissionMode &&
      permissionCeiling &&
      !unattendedPermissionAllowed('auto', permissionCeiling)
    ) {
      permissionMode = permissionCeiling;
    }

    const iterationCap = request.unattended ? loadedPolicy.policy.unattended.maxIterations : undefined;
    if (request.maxIterations !== undefined && iterationCap !== undefined && request.maxIterations > iterationCap) {
      throw new PolicyViolationError(
        'unattended',
        `max iterations ${request.maxIterations} exceeds unattended cap ${iterationCap}`,
        String(request.maxIterations),
      );
    }
    const maxIterations = request.maxIterations ?? Math.min(DEFAULT_TURN_CONFIG.maxIterations, iterationCap ?? Infinity);

    const wallCap = request.unattended ? loadedPolicy.policy.unattended.maxWallMinutes : undefined;
    if (request.timeoutMinutes !== undefined && wallCap !== undefined && request.timeoutMinutes > wallCap) {
      throw new PolicyViolationError(
        'unattended',
        `timeout ${request.timeoutMinutes} minutes exceeds unattended cap ${wallCap}`,
        String(request.timeoutMinutes),
      );
    }
    const timeoutMinutes = request.timeoutMinutes ?? Math.min(DEFAULT_RUN_TIMEOUT_MINUTES, wallCap ?? Infinity);
    timeoutSignal = AbortSignal.timeout(timeoutMinutes * 60_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    const config: Partial<TurnConfig> = { maxIterations };
    if (request.maxToolCalls !== undefined) config.maxToolCallsPerTurn = request.maxToolCalls;

    // Snapshot the fix-record store before the turn so the run is credited only
    // with records it filed. A record is written by whatever `dvalin verify` the
    // agent reaches for, under that command's own audit run, so there is no run
    // id to join on -- what is new since this point is the only honest answer.
    verificationCollector = createVerificationCollector(cwd);
    verificationCollector.begin();

    const turn = await runAgentTurn(
      {
        content: request.content,
        cwd,
        sessionId: request.sessionId,
        mode: request.mode ?? 'code',
        codePermissionMode: permissionMode,
        providerOverride: request.provider,
        modelOverride: request.model,
        profileOverride: request.profile,
        turnConfig: config,
        origin: request.origin ?? 'cli',
        signal,
      },
      {
        onSessionId: id => {
          sessionId = id;
        },
        onProviderSelected: (providerId, selectedModel) => {
          provider = providerId;
          model = selectedModel;
          hooks.onProviderSelected?.(providerId, selectedModel);
        },
        onRunStart: details => {
          runId = details.runId;
          policyHash = details.policyHash;
          hooks.onRunStart?.({ type: 'run_start', ...details });
        },
        onEvent: event => {
          if (event.type === 'tool_call') toolCalls++;
          if (event.type === 'llm_iteration') iterationsUsed = event.iteration;
          verificationCollector?.observe(event);
          hooks.onEvent?.(event);
        },
        // A headless surface has no human approval channel. Any tool path that
        // requires a confirmation must fail promptly and be audited as denied.
        requestApproval: async () => false,
      },
    );

    sessionId = turn.sessionId;
    runId = turn.result.runId;
    policyHash = turn.policyHash;
    provider = turn.providerId;
    model = turn.model;
    iterationsUsed = turn.result.iterationsUsed;
    usage = turn.result.usage ?? usage;
    output = turn.result.output;

    if (request.reportFile) {
      if (!turn.reportMarkdown) throw new Error('Run report was not available.');
      const reportPath = path.resolve(request.reportFile);
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath, turn.reportMarkdown, 'utf8');
    }

    const execution = finish(0, turn.result.stopReason ?? 'done', undefined, turn.result.auditHead);
    execution.reportMarkdown = turn.reportMarkdown;
    return execution;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof HarnessUsageError) return finish(2, 'error', message);
    if (err instanceof PolicyViolationError) return finish(3, 'error', message);
    if (request.signal?.aborted) return finish(4, 'interrupted', message);
    if (timeoutSignal?.aborted) return finish(4, 'timeout', message);
    return finish(1, 'error', message);
  }
}

function validatePositiveNumber(value: number | undefined, label: string, integer: boolean): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new HarnessUsageError(`${label} must be a positive ${integer ? 'integer' : 'number'}.`);
  }
}
