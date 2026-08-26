import type { SecurityCoverage, SecurityGateResult } from './contracts.js';

/**
 * State the coverage next to the verdict, always. A gate result read without it
 * says more than the scan knows.
 */
export function renderCoverage(coverage: SecurityCoverage): string {
  const lines = [`Coverage: ${coverage.status}`];
  for (const entry of coverage.deferred) lines.push(`  · deferred: ${entry}`);
  for (const entry of coverage.exclusions) lines.push(`  · excluded: ${entry}`);
  for (const note of coverage.notes) lines.push(`  · ${note}`);
  return lines.join('\n');
}

/** `none` is an advisory policy, not a security pass. */
export function renderSecurityGate(gate: SecurityGateResult): string {
  const status = gate.threshold === 'none' ? 'ADVISORY' : gate.passed ? 'PASS' : 'FAIL';
  return `Gate: ${status} · ${gate.mode} findings · threshold ${gate.threshold}`;
}
