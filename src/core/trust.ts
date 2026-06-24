import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defaultAuditDir, listRuns } from '../audit/log.js';
import {
  loadPolicy,
  checkEgress,
  permissivePolicy,
  policyHash,
  type PolicySource,
  type ResolvedPolicy,
} from './policy.js';
import {
  detectSubprocessSandboxCapabilities,
  selectSubprocessSandbox,
} from './subprocessSandbox.js';

/**
 * `dvalincode trust` — the product embodiment of the North Star: the tool issues its
 * own, install-specific security posture so an approver can verify it directly instead
 * of taking claims on trust. Covers the three principles at a glance:
 *   可控   — the resolved org policy that bounds this install
 *   可审计 — the tamper-evident audit trail and how to verify it
 *   透明   — version, runtime, and (in dev) the dependency surface
 */

/** Keep in lockstep with the version in src/cli.ts. */
const VERSION = '0.8.1';

export type TrustReport = {
  version: string;
  runtime: { engine: 'bun' | 'node'; engineVersion: string; platform: string; arch: string };
  policy: {
    hash: string;
    /** True when any constraint is active (i.e. not the permissive default). */
    constrained: boolean;
    sources: PolicySource[];
    resolved: ResolvedPolicy;
  };
  audit: { dir: string; runCount: number };
  networkEnforcement: {
    provider: { status: 'blocked' | 'enforced' | 'unrestricted'; mechanism: string };
    shell: { status: 'enforced' | 'unavailable' | 'unrestricted'; mechanism: string };
    runCheck: { status: 'enforced' | 'unavailable' | 'unrestricted'; mechanism: string };
  };
  /** dvalincode's own runtime dependencies; omitted when not resolvable (e.g. in a compiled binary). */
  dependencies?: Record<string, string>;
};

export function buildTrustReport(cwd: string = process.cwd()): TrustReport {
  const loaded = loadPolicy(cwd);
  const engine: 'bun' | 'node' = process.versions.bun ? 'bun' : 'node';
  const capabilities = detectSubprocessSandboxCapabilities();
  const requiresSubprocessIsolation = !checkEgress(loaded.policy, false).allowed;
  const shellPlan = selectSubprocessSandbox(
    process.platform,
    requiresSubprocessIsolation,
    capabilities,
    true,
  );
  const runCheckPlan = selectSubprocessSandbox(
    process.platform,
    requiresSubprocessIsolation,
    capabilities,
  );
  return {
    version: VERSION,
    runtime: {
      engine,
      engineVersion: process.versions.bun ?? process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    policy: {
      hash: loaded.hash,
      constrained: loaded.hash !== policyHash(permissivePolicy()),
      sources: loaded.sources,
      resolved: loaded.policy,
    },
    audit: { dir: defaultAuditDir(), runCount: listRuns().length },
    networkEnforcement: {
      provider: providerEnforcement(loaded.policy.network),
      shell: shellEnforcement(shellPlan),
      runCheck: shellEnforcement(runCheckPlan),
    },
    dependencies: readOwnDependencies(),
  };
}

/** Best-effort read of dvalincode's own package.json dependencies. */
function readOwnDependencies(): Record<string, string> | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
    return pkg.dependencies ?? undefined;
  } catch {
    return undefined;
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────────

const NETWORK_NOTE: Record<ResolvedPolicy['network'], string> = {
  off: 'no outbound network',
  'endpoint-only': 'model endpoint only',
  on: 'unrestricted',
};

export function renderTrustReport(r: TrustReport): string {
  const lines: string[] = [];
  const p = r.policy.resolved;

  lines.push('DvalinCode — trust report');
  lines.push(`  version   ${r.version}`);
  lines.push(`  runtime   ${r.runtime.engine} ${r.runtime.engineVersion} · ${r.runtime.platform}/${r.runtime.arch}`);
  lines.push('');

  lines.push(`可控 / Policy   ${r.policy.constrained ? 'constrained' : 'permissive — no policy file in effect'}`);
  lines.push(`  hash      ${short(r.policy.hash)}`);
  lines.push('  sources');
  for (const s of r.policy.sources) {
    const status = s.error ? `IGNORED (${s.error})` : s.present ? `sha256:${short(s.hash)}` : 'absent';
    lines.push(`    ${s.layer.padEnd(8)} ${s.path}  ${status}`);
  }
  lines.push('  effective');
  lines.push(`    modes        ${p.modes.join(', ') || '(none)'}`);
  lines.push(`    network      ${p.network} — ${NETWORK_NOTE[p.network]}`);
  lines.push(`    providers    ${p.providers.allow ? `allow: ${p.providers.allow.join(', ')}` : 'any'}`);
  lines.push(`    models       ${p.models.allow ? `allow: ${p.models.allow.join(', ')}` : 'any'}`);
  lines.push(`    commands     ${describeCommands(p)}`);
  lines.push(`    paths        ${describePaths(p)}`);
  lines.push(`    tools        ${p.tools.deny.length ? `deny: ${p.tools.deny.join(', ')}` : 'all allowed'}`);
  lines.push(`    maxToolCalls ${p.maxToolCalls ?? 'unlimited'}`);
  lines.push('  enforcement');
  lines.push(
    `    provider     ${r.networkEnforcement.provider.status} — ${r.networkEnforcement.provider.mechanism}`,
  );
  lines.push(`    shell        ${r.networkEnforcement.shell.status} — ${r.networkEnforcement.shell.mechanism}`);
  lines.push(`    run_check    ${r.networkEnforcement.runCheck.status} — ${r.networkEnforcement.runCheck.mechanism}`);
  lines.push('');

  lines.push('可审计 / Audit');
  lines.push(`  dir       ${r.audit.dir}`);
  lines.push(`  runs      ${r.audit.runCount} recorded`);
  lines.push('  verify    dvalincode report verify <run-id>');

  if (r.dependencies) {
    lines.push('');
    lines.push('透明 / Dependencies');
    const deps = Object.entries(r.dependencies)
      .map(([name, ver]) => `${name}@${ver}`)
      .join(', ');
    lines.push(`  ${deps}`);
  }

  return lines.join('\n');
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

function providerEnforcement(
  network: ResolvedPolicy['network'],
): TrustReport['networkEnforcement']['provider'] {
  if (network === 'off') {
    return { status: 'blocked', mechanism: 'bundled provider request gate' };
  }
  if (network === 'endpoint-only') {
    return { status: 'enforced', mechanism: 'configured-origin check with redirect revalidation' };
  }
  return { status: 'unrestricted', mechanism: 'policy permits provider egress' };
}

function shellEnforcement(
  plan: ReturnType<typeof selectSubprocessSandbox>,
): TrustReport['networkEnforcement']['shell'] {
  if (!plan.allowed) {
    return { status: 'unavailable', mechanism: plan.reason };
  }
  if (plan.sandbox === 'seatbelt') {
    return { status: 'enforced', mechanism: 'macOS sandbox-exec deny network*' };
  }
  if (plan.sandbox === 'bwrap') {
    return { status: 'enforced', mechanism: 'Bubblewrap unshared network namespace' };
  }
  return { status: 'unrestricted', mechanism: 'no shell network sandbox active' };
}
