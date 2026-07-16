import type { Command } from 'commander';
import path from 'node:path';
import { resolveCheckedPolicy, repoPolicyPath, type PolicySource, type ResolvedPolicy } from '../core/policy.js';

const NETWORK_NOTE: Record<ResolvedPolicy['network'], string> = {
  off: 'no outbound network',
  'endpoint-only': 'model endpoint only',
  on: 'unrestricted',
};

export function registerPolicyCommand(program: Command): void {
  const policy = program
    .command('policy')
    .description('Validate and inspect org policy files (dvalin.policy.json)');

  policy
    .command('check')
    .description('Validate a policy file against the schema and print the resolved policy + hash')
    .argument('[path]', 'policy file to check (default: ./dvalin.policy.json)')
    .option('--json', 'output the result as JSON')
    .action((file: string | undefined, options: { json?: boolean }) => {
      const target = file ?? repoPolicyPath(process.cwd());
      const result = resolveCheckedPolicy(target);

      if (!result.ok) {
        if (options.json) {
          console.log(JSON.stringify({ ok: false, path: result.path, kind: result.kind, errors: result.errors }, null, 2));
        } else {
          console.error(`✗ validation failed: ${result.path}`);
          for (const err of result.errors) console.error(`  ${err}`);
        }
        process.exit(1);
      }

      if (result.machineWarning) {
        console.warn(`⚠ Ignored malformed machine policy: ${result.machineWarning}`);
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              path: result.path,
              hash: result.hash,
              sources: result.sources,
              resolved: result.policy,
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`✓ ${path.basename(result.path)} is valid`);
      console.log('');
      console.log('Resolved policy (after narrowing with machine layer):');
      console.log(`  hash      ${result.hash}`);
      console.log('  sources');
      for (const s of result.sources) {
        console.log(`    ${sourceLine(s)}`);
      }
      console.log('  effective');
      console.log(renderEffective(result.policy));
    });
}

function sourceLine(s: PolicySource): string {
  const status = s.error ? `IGNORED (${s.error})` : s.present ? `sha256:${short(s.hash)}` : 'absent';
  return `${s.layer.padEnd(8)} ${s.path}  ${status}`;
}

function renderEffective(p: ResolvedPolicy): string {
  const lines = [
    `    modes        ${p.modes.join(', ') || '(none)'}`,
    `    network      ${p.network} — ${NETWORK_NOTE[p.network]}`,
    `    providers    ${p.providers.allow ? `allow: ${p.providers.allow.join(', ')}` : 'any'}`,
    `    models       ${p.models.allow ? `allow: ${p.models.allow.join(', ')}` : 'any'}`,
    `    commands     ${describeCommands(p)}`,
    `    paths        ${describePaths(p)}`,
    `    tools        ${p.tools.deny.length ? `deny: ${p.tools.deny.join(', ')}` : 'all allowed'}`,
    `    mcp          ${p.mcp.allow ? `allow: ${p.mcp.allow.join(', ')}` : 'any configured server'}`,
    `    maxToolCalls ${p.maxToolCalls ?? 'unlimited'}`,
    `    unattended  ${describeUnattended(p)}`,
  ];
  return lines.join('\n');
}

function describeUnattended(p: ResolvedPolicy): string {
  const u = p.unattended;
  const parts: string[] = [];
  if (u.maxPermissionMode) parts.push(`permission≤${u.maxPermissionMode}`);
  if (u.maxIterations) parts.push(`iterations≤${u.maxIterations}`);
  if (u.maxWallMinutes) parts.push(`wall≤${u.maxWallMinutes}m`);
  return parts.length ? parts.join(', ') : 'unrestricted';
}

function describeCommands(p: ResolvedPolicy): string {
  if (p.commands.allow) return `allowlist: ${p.commands.allow.join(', ')}`;
  const parts: string[] = [];
  if (p.commands.defaultDeny) parts.push('default-deny');
  if (p.commands.deny.length) parts.push(`deny: ${p.commands.deny.join(', ')}`);
  return parts.length ? parts.join('; ') : 'all allowed';
}

function describePaths(p: ResolvedPolicy): string {
  const parts: string[] = [];
  if (p.paths.allow) parts.push(`allowlist: ${p.paths.allow.join(', ')}`);
  if (p.paths.deny.length) parts.push(`deny: ${p.paths.deny.join(', ')}`);
  return parts.length ? parts.join('; ') : 'workspace (per .dvalincodeignore)';
}

function short(hash: string | null): string {
  return hash ? hash.slice(0, 12) : '—';
}
