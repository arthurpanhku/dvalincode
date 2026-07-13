import type { AuditSink } from '../audit/log.js';
import { permissivePolicy, type ResolvedPolicy } from './policy.js';

export type ApprovalMode = 'readonly' | 'auto-edit' | 'full-auto' | 'bypass';

export type DvalinContextOptions = {
  cwd?: string;
  allowWrite?: boolean;
  allowExecute?: boolean;
  maxBytes?: number;
  approvalMode?: ApprovalMode;
  requestApproval?: (id: string, toolName: string, input: unknown) => Promise<boolean>;
  /** Optional per-run audit sink. When present, tool taps emit audit events. */
  audit?: AuditSink;
  /** Resolved org policy. Defaults to permissive (identical to having no policy file). */
  policy?: ResolvedPolicy;
  /** Optional cancellation signal for the active agent turn. */
  signal?: AbortSignal;
};

export type DvalinContext = {
  cwd: string;
  allowWrite: boolean;
  allowExecute: boolean;
  maxBytes: number;
  approvalMode: ApprovalMode;
  requestApproval?: (id: string, toolName: string, input: unknown) => Promise<boolean>;
  /** Optional per-run audit sink. When present, tool taps emit audit events. */
  audit?: AuditSink;
  /** Resolved org policy, enforced at the tool chokepoint. */
  policy: ResolvedPolicy;
  /** Optional cancellation signal for the active agent turn. */
  signal?: AbortSignal;
};

export function createDvalinContext(options: DvalinContextOptions = {}): DvalinContext {
  const mode = options.approvalMode;

  let allowWrite: boolean;
  let allowExecute: boolean;
  if (mode === 'readonly') {
    allowWrite = false;
    allowExecute = false;
  } else if (mode === 'auto-edit' || mode === 'full-auto' || mode === 'bypass') {
    allowWrite = true;
    allowExecute = true;
  } else {
    allowWrite = options.allowWrite ?? false;
    allowExecute = options.allowExecute ?? false;
  }

  return {
    cwd: options.cwd ?? process.cwd(),
    allowWrite,
    allowExecute,
    maxBytes: options.maxBytes ?? 256_000,
    approvalMode: mode ?? 'full-auto',
    // Bypass is a runtime-wide auto-approval mode, not merely permission to
    // use write/execute tools. Keep this at the shared context chokepoint so
    // current and future approval sources cannot accidentally surface a
    // per-action prompt (including unrestricted shell network access).
    requestApproval: mode === 'bypass'
      ? async () => true
      : options.requestApproval,
    audit: options.audit,
    policy: options.policy ?? permissivePolicy(),
    signal: options.signal,
  };
}
