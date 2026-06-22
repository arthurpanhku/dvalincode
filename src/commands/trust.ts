import type { Command } from 'commander';
import { buildTrustReport, renderTrustReport } from '../core/trust.js';

export function registerTrustCommand(program: Command): void {
  program
    .command('trust')
    .description('Print this install\'s security posture: active policy, audit status, runtime')
    .option('--json', 'output the report as JSON')
    .action((options: { json?: boolean }) => {
      const report = buildTrustReport();
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(renderTrustReport(report));
    });
}
