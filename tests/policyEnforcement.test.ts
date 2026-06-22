import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDvalinContext } from '../src/core/context.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { resolvePolicy, PolicyViolationError } from '../src/core/policy.js';
import type { AuditEvent } from '../src/audit/log.js';
import type { Tool } from '../src/tools/types.js';

/** A no-op execute tool that exposes its command as a policy target. */
const fakeShell: Tool<{ command: string }> = {
  name: 'fake_shell',
  description: 'fake',
  access: 'execute',
  inputSchema: z.object({ command: z.string() }).strict(),
  policyTargets: input => [{ kind: 'command', value: input.command }],
  async run(input) {
    return { title: 'ran', output: input.command };
  },
};

/** A no-op write tool that exposes its path as a policy target. */
const fakeWrite: Tool<{ filePath: string }> = {
  name: 'fake_write',
  description: 'fake',
  access: 'write',
  inputSchema: z.object({ filePath: z.string() }).strict(),
  policyTargets: input => [{ kind: 'path', value: input.filePath }],
  async run(input) {
    return { title: 'wrote', output: input.filePath };
  },
};

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(fakeShell);
  r.register(fakeWrite);
  return r;
}

/** Capture audit events without touching disk. */
function captureAudit() {
  const events: AuditEvent[] = [];
  return { append: (e: AuditEvent) => events.push(e), getWarnings: () => [], events } as const;
}

describe('policy enforcement at the tool chokepoint', () => {
  it('permissive policy (the default) runs tools unchanged', async () => {
    const ctx = createDvalinContext({ approvalMode: 'full-auto' });
    const result = await registry().run('fake_shell', { command: 'ls' }, ctx);
    expect(result.output).toBe('ls');
  });

  it('blocks a denied command before it runs and audits the violation', async () => {
    const audit = captureAudit();
    const ctx = createDvalinContext({
      approvalMode: 'full-auto',
      policy: resolvePolicy([{ commands: { deny: ['^rm\\b'] } }]),
      audit: audit as never,
    });

    await expect(registry().run('fake_shell', { command: 'rm -rf /' }, ctx)).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({ type: 'policy_violation', tool: 'fake_shell' });
  });

  it('blocks a denied path before any write happens', async () => {
    const ctx = createDvalinContext({
      approvalMode: 'full-auto',
      policy: resolvePolicy([{ paths: { deny: ['**/.env'] } }]),
    });
    await expect(registry().run('fake_write', { filePath: 'app/.env' }, ctx)).rejects.toThrow(/Blocked by policy/);
    // A non-matching path still works.
    const ok = await registry().run('fake_write', { filePath: 'src/index.ts' }, ctx);
    expect(ok.output).toBe('src/index.ts');
  });

  it('enforces the tool denylist', async () => {
    const ctx = createDvalinContext({
      approvalMode: 'full-auto',
      policy: resolvePolicy([{ tools: { deny: ['fake_shell'] } }]),
    });
    await expect(registry().run('fake_shell', { command: 'ls' }, ctx)).rejects.toBeInstanceOf(PolicyViolationError);
  });

  it('reports the offending rule on the error', async () => {
    const ctx = createDvalinContext({
      approvalMode: 'full-auto',
      policy: resolvePolicy([{ commands: { allow: ['^npm\\b'] } }]),
    });
    await expect(registry().run('fake_shell', { command: 'curl evil' }, ctx)).rejects.toMatchObject({
      name: 'PolicyViolationError',
      rule: expect.stringContaining('allowlist'),
    });
  });
});
