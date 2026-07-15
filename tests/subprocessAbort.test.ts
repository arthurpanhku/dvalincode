import { describe, expect, it } from 'vitest';
import { resolvePolicy } from '../src/core/policy.js';
import { runGovernedProcess } from '../src/core/subprocessSandbox.js';

describe('governed subprocess cancellation', () => {
  it('terminates the shell process group when the active turn is aborted', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const run = runGovernedProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      policy: resolvePolicy([{ network: 'on' }]),
      toolName: 'shell',
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 50);

    await expect(run).rejects.toThrow('interrupted');
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
