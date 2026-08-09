import type { Command } from 'commander';
import { EXIT } from '../core/exitCodes.js';
import { latestRun, readRecords, verifyChain } from '../audit/log.js';
import { renderReport } from '../audit/report.js';

export function registerReportCommand(program: Command): void {
  const report = program
    .command('report')
    .description('Show or verify the audit trail / Run Report for an agent run')
    .argument('[run-id]', 'run id (defaults to the most recent run)')
    .option('--last', 'use the most recent run (default when no run id is given)')
    .option('--format <format>', 'output format: markdown | json', 'markdown')
    .action((runId: string | undefined, options: { last?: boolean; format: string }) => {
      const id = resolveRunId(runId);
      if (!id) {
        console.error('No audit runs found. Run an agent task first.');
        process.exit(EXIT.usageError);
      }

      if (options.format === 'json') {
        console.log(JSON.stringify(readRecords(id), null, 2));
        return;
      }
      console.log(renderReport(id));
    });

  report
    .command('verify')
    .description('Validate the tamper-evident hash chain of a run log')
    .argument('[run-id]', 'run id (defaults to the most recent run)')
    .action((runId: string | undefined) => {
      const id = resolveRunId(runId);
      if (!id) {
        console.error('No audit runs found.');
        process.exit(EXIT.usageError);
      }
      const result = verifyChain(id);
      if (result.ok) {
        console.log(`✓ chain intact — ${id}`);
        return;
      }
      const where = result.brokenAtSeq !== undefined ? ` at seq ${result.brokenAtSeq}` : '';
      console.error(`✗ chain broken${where} — ${id}${result.reason ? `: ${result.reason}` : ''}`);
      // A broken chain is the answer, not a malfunction — the same code a
      // failed Evidence Pack verification and a tripped scan gate return.
      process.exit(EXIT.gateNotMet);
    });
}

function resolveRunId(runId: string | undefined): string | null {
  if (runId && runId.length > 0) return runId;
  return latestRun();
}
