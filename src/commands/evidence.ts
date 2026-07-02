import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { buildEvidencePack, verifyEvidencePack, type EvidencePack } from '../evidence/pack.js';

export function registerEvidenceCommand(program: Command): void {
  const evidence = program
    .command('evidence')
    .description('Produce and verify an offline governance Evidence Pack (policy + posture + audit proofs)');

  evidence
    .command('export')
    .description('Write an offline-verifiable Evidence Pack for this install')
    .option('--out <file>', 'output path (default: dvalincode-evidence-<timestamp>.json)')
    .option('--run <id...>', 'specific run id(s) to include')
    .option('--last <n>', 'include the newest N audit runs (default 10)', v => parseInt(v, 10))
    .action((options: { out?: string; run?: string[]; last?: number }) => {
      const pack = buildEvidencePack({ runIds: options.run, last: options.last });
      const out = options.out ?? `dvalincode-evidence-${pack.generatedAt.replace(/[:.]/g, '-')}.json`;
      writeFileSync(out, JSON.stringify(pack, null, 2), 'utf8');

      const backed = pack.compliance.filter(c => c.backed).length;
      console.log(`✓ Evidence Pack written: ${out}`);
      console.log(`  policy hash   ${pack.policy.hash.slice(0, 16)}…`);
      console.log(`  runs          ${pack.runs.length} (${pack.runs.filter(r => r.verify.ok).length} chains verified)`);
      console.log(`  compliance    ${backed}/${pack.compliance.length} controls backed by this pack`);
      console.log(`  bundle hash   ${pack.manifest.bundleHash.slice(0, 16)}…`);
      console.log('  verify with   dvalincode evidence verify ' + out);
    });

  evidence
    .command('verify')
    .description('Re-derive every hash and re-check each embedded audit chain, fully offline')
    .argument('<file>', 'path to an Evidence Pack')
    .action((file: string) => {
      let pack: EvidencePack;
      try {
        pack = JSON.parse(readFileSync(file, 'utf8')) as EvidencePack;
      } catch (err) {
        console.error(`Cannot read Evidence Pack: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      const report = verifyEvidencePack(pack);
      if (report.ok) {
        console.log(`✓ Evidence Pack intact — ${pack.runs.length} run chain(s) verified, all section hashes match`);
        return;
      }
      console.error('✗ Evidence Pack verification FAILED');
      for (const issue of [...report.sectionIssues, ...report.runIssues, ...report.minimizationIssues]) {
        console.error(`  - ${issue}`);
      }
      process.exit(1);
    });
}
