import type { Command } from 'commander';
import { AuditSink, newRunId } from '../audit/log.js';
import { listCheckpoints } from '../core/checkpoint.js';
import { createDvalinContext } from '../core/context.js';
import { loadPolicy } from '../core/policy.js';
import { createRollbackRegistry } from '../tools/rollbackRun.js';

export function registerCheckpointCommands(program: Command): void {
  program.command('checkpoint').description('Manage local run checkpoints')
    .command('list').description('List available run snapshots')
    .action(async () => {
      const checkpoints = await listCheckpoints();
      for (const { runId, root, changed } of checkpoints) console.log(`${runId}\t${changed}\t${root}`);
    });
  program.command('rollback <run-id>').description('Restore files from a run checkpoint')
    .action(async (runId: string) => console.log(await executeRollback(runId, process.cwd())));
}

export async function executeRollback(runId: string, cwd: string): Promise<string> {
  const { registry } = await createRollbackRegistry(runId);
  const loaded = loadPolicy(cwd);
  if (loaded.sources.some(source => source.error)) throw new Error('Rollback requires a readable workspace policy');
  const audit = new AuditSink(newRunId());
  audit.append({ type: 'run_start', task: 'rollback', mode: 'rollback', provider: 'none', model: 'none', cwd, gitHead: null, policyHash: loaded.hash });
  try {
    const result = await registry.run('rollback_run', { runId }, createDvalinContext({ cwd, allowWrite: true, policy: loaded.policy, audit }));
    audit.append({ type: 'run_end', status: 'done', iterations: 0 });
    return result.output;
  } catch (error) {
    audit.append({ type: 'run_end', status: 'error', iterations: 0 });
    throw error;
  }
}
