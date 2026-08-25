import { randomUUID } from 'node:crypto';
import { AuditSink } from '../audit/log.js';
import { loadPolicy } from '../core/policy.js';
import { runProjectVerification } from '../remediation/verify.js';
import { runDvalinScanSuite, type DvalinScanSuiteResult } from '../remediation/scannerSuite.js';
import { deriveCoverage } from './contracts.js';
import { saveFixRecord } from './fixRecordStore.js';
import type { DvalinSecurityConfig } from './config.js';
import type { FixExecutor } from './fixRecord.js';
import {
  evaluateWorkflowVerificationGate,
  verifySecurityWorkflow,
  type SecurityWorkflow,
} from './workflow.js';

/**
 * The one verification path.
 *
 * Every surface that verifies a repair — this command, the `--fix --verify`
 * pipeline, and the MCP server — comes through here, so "verified" means the
 * same thing regardless of who asked. Dvalin re-scans, Dvalin runs the checks,
 * and the record is issued from what Dvalin observed.
 */
export async function runWorkflowVerification(input: {
  workflow: SecurityWorkflow;
  checks: DvalinSecurityConfig['checks'];
  timeoutMs?: number;
  executor?: FixExecutor;
  verifyCommands?: string[];
}): Promise<SecurityWorkflow> {
  const { workflow } = input;
  // The checks are governed commands; opening a run puts them in the
  // hash-chained log so the record has something to anchor to.
  const audit = new AuditSink(`verify-${randomUUID().slice(0, 8)}`);
  const loadedPolicy = loadPolicy(workflow.root);
  audit.append({
    type: 'run_start',
    task: `security verify ${workflow.id}`,
    mode: 'security-verify',
    provider: 'none',
    model: 'none',
    cwd: workflow.root,
    gitHead: null,
    policyHash: loadedPolicy.hash,
  });

  let result: DvalinScanSuiteResult;
  let verification: Awaited<ReturnType<typeof runProjectVerification>>;
  try {
    result = await runDvalinScanSuite(workflow.root, {
      scanners: workflow.scanners,
      timeoutMs: input.timeoutMs,
    });
    verification = await runProjectVerification({
      cwd: workflow.root,
      kinds: input.checks,
      commands: input.verifyCommands?.length ? input.verifyCommands : undefined,
      timeoutMs: input.timeoutMs,
      audit,
    });
  } finally {
    audit.append({ type: 'run_end', status: 'done', iterations: 1, warnings: audit.getWarnings() });
  }

  const gate = evaluateWorkflowVerificationGate(workflow, result);
  const updated = await verifySecurityWorkflow({
    workflow,
    result,
    gate,
    checks: verification.evidence,
    coverage: deriveCoverage(result),
    executor: input.executor,
    audit: { runId: audit.runId, headHash: audit.head() },
    policyHash: loadedPolicy.hash,
  });
  if (updated.verification?.record) saveFixRecord(updated.verification.record);
  return updated;
}
