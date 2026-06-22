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
    requestApproval: options.requestApproval,
    audit: options.audit,
    policy: options.policy ?? permissivePolicy(),
  };
}
