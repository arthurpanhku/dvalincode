import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { sha256, canonicalJSON } from '../audit/hash.js';

/**
 * Org policy — the "可控 / controllable" pillar (see docs/APPROVABILITY-PLAN.md, Epic A1).
 *
 * A company, not the developer, bounds the agent's blast radius. Policy is discovered
 * from two layers and resolved by **narrowing (intersection)**: a repo-committed policy
 * can only ever make the machine-level policy *stricter*, never wider. This is the
 * keystone everyone else reads — `dvalincode trust` reports the resolved policy, the
 * Approval Pack snapshots it, and the tool layer enforces it.
 *
 * Threat model: the agent runs on the developer's own machine, so policy is
 * default-enforced and tamper-*evident* (its hash is recorded in the audit log at
 * run_start), not tamper-*proof* against a hostile local admin. Hard enforcement is the
 * job of the future server-mediated mode (A5).
 */

export const networkLevels = ['off', 'endpoint-only', 'on'] as const;
export type NetworkLevel = (typeof networkLevels)[number];

export const agentModes = ['chat', 'cowork', 'code'] as const;
export type AgentMode = (typeof agentModes)[number];

/** Restrictiveness rank — lower is stricter. Used to pick the most restrictive level. */
const NETWORK_RANK: Record<NetworkLevel, number> = { off: 0, 'endpoint-only': 1, on: 2 };

/** The shape of a policy file as authored. Every field is optional; absent = unrestricted. */
const policyFileSchema = z
  .object({
    modes: z.array(z.enum(agentModes)).optional(),
    providers: z.object({ allow: z.array(z.string()).optional() }).strict().optional(),
    models: z.object({ allow: z.array(z.string()).optional() }).strict().optional(),
    commands: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
        defaultDeny: z.boolean().optional(),
      })
      .strict()
      .optional(),
    paths: z
      .object({
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    tools: z.object({ deny: z.array(z.string()).optional() }).strict().optional(),
    mcp: z.object({ allow: z.array(z.string()).optional() }).strict().optional(),
    network: z.enum(networkLevels).optional(),
    maxToolCalls: z.number().int().positive().optional(),
  })
  .strict();

export type OrgPolicyInput = z.infer<typeof policyFileSchema>;

/** A fully-resolved policy: defaults applied, all sources narrowed together. */
export type ResolvedPolicy = {
  /** Modes the agent may run in (default: all). */
  modes: AgentMode[];
  /** Provider id allowlist; undefined = any provider. */
  providers: { allow?: string[] };
  /** Model id allowlist; undefined = any model. */
  models: { allow?: string[] };
  /** Shell command policy. `allow` (if set) is an allowlist; `deny` always blocks. */
  commands: { allow?: string[]; deny: string[]; defaultDeny: boolean };
  /** Filesystem path policy, layered on top of .dvalincodeignore. Globs. */
  paths: { allow?: string[]; deny: string[] };
  /** Tool-name denylist. */
  tools: { deny: string[] };
  /** MCP server-id allowlist; undefined = any configured server is permitted. */
  mcp: { allow?: string[] };
  /** Outbound network posture. */
  network: NetworkLevel;
  /** Hard cap on tool calls per run; undefined = unlimited. */
  maxToolCalls?: number;
};

/** The most permissive policy — equivalent to having no policy file at all. */
export function permissivePolicy(): ResolvedPolicy {
  return {
    modes: [...agentModes],
    providers: {},
    models: {},
    commands: { deny: [], defaultDeny: false },
    paths: { deny: [] },
    tools: { deny: [] },
    mcp: {},
    network: 'on',
  };
}

/** A policy decision. When denied, `rule` names the constraint that blocked it. */
export type Decision = { allowed: true } | { allowed: false; rule: string };

/**
 * Thrown when the tool layer blocks a call by policy. Carries structured fields so a
 * frontend can render it as a native inline denial (e.g. `⛔ Blocked by policy: …`)
 * rather than a raw error, keeping the UX on par with mainstream coding agents.
 */
export class PolicyViolationError extends Error {
  readonly tool: string;
  readonly rule: string;
  readonly target: string;
  constructor(tool: string, rule: string, target: string) {
    super(`Blocked by policy: ${rule}`);
    this.name = 'PolicyViolationError';
    this.tool = tool;
    this.rule = rule;
    this.target = target;
  }
}

const ALLOW: Decision = { allowed: true };
const deny = (rule: string): Decision => ({ allowed: false, rule });

// ── Resolution (narrowing) ────────────────────────────────────────────────────
// Every combinator only ever *restricts*. Order of sources is therefore irrelevant
// to safety: a developer-supplied source can never widen an IT-supplied one.

// List-valued fields carry set semantics, so every combinator returns a sorted result.
// This makes the resolved policy canonical: its hash is independent of source order,
// which is exactly what a tamper-evidence hash needs.

function intersectList<T>(a: T[], b: T[]): T[] {
  const set = new Set(b);
  return a.filter(x => set.has(x)).sort();
}

/** Intersect two allowlists where "undefined" means "no restriction (all)". */
function intersectAllow(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b ? [...b].sort() : undefined;
  if (b === undefined) return [...a].sort();
  return intersectList(a, b);
}

function union(a: string[], b: string[] | undefined): string[] {
  return [...new Set([...a, ...(b ?? [])])].sort();
}

function moreRestrictiveNetwork(a: NetworkLevel, b: NetworkLevel): NetworkLevel {
  return NETWORK_RANK[a] <= NETWORK_RANK[b] ? a : b;
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Narrow a resolved policy by one authored source. Result is never wider than `base`. */
function narrow(base: ResolvedPolicy, next: OrgPolicyInput): ResolvedPolicy {
  return {
    modes: next.modes ? intersectList(base.modes, next.modes) : base.modes,
    providers: { allow: intersectAllow(base.providers.allow, next.providers?.allow) },
    models: { allow: intersectAllow(base.models.allow, next.models?.allow) },
    commands: {
      allow: intersectAllow(base.commands.allow, next.commands?.allow),
      deny: union(base.commands.deny, next.commands?.deny),
      defaultDeny: base.commands.defaultDeny || (next.commands?.defaultDeny ?? false),
    },
    paths: {
      allow: intersectAllow(base.paths.allow, next.paths?.allow),
      deny: union(base.paths.deny, next.paths?.deny),
    },
    tools: { deny: union(base.tools.deny, next.tools?.deny) },
    mcp: { allow: intersectAllow(base.mcp.allow, next.mcp?.allow) },
    network: next.network ? moreRestrictiveNetwork(base.network, next.network) : base.network,
    maxToolCalls: minDefined(base.maxToolCalls, next.maxToolCalls),
  };
}

/** Resolve a set of authored policies into one effective policy by narrowing. */
export function resolvePolicy(sources: OrgPolicyInput[]): ResolvedPolicy {
  return sources.reduce<ResolvedPolicy>(narrow, permissivePolicy());
}

// ── Decision functions (enforced by the tool layer in A2) ───────────────────────

export function checkMode(p: ResolvedPolicy, mode: AgentMode): Decision {
  return p.modes.includes(mode) ? ALLOW : deny(`mode "${mode}" is not permitted by policy`);
}

export function checkProvider(p: ResolvedPolicy, provider: string): Decision {
  if (!p.providers.allow) return ALLOW;
  return p.providers.allow.includes(provider) ? ALLOW : deny(`provider "${provider}" is not in the allowlist`);
}

export function checkModel(p: ResolvedPolicy, model: string): Decision {
  if (!p.models.allow) return ALLOW;
  return p.models.allow.includes(model) ? ALLOW : deny(`model "${model}" is not in the allowlist`);
}

export function checkTool(p: ResolvedPolicy, toolName: string): Decision {
  return p.tools.deny.includes(toolName) ? deny(`tool "${toolName}" is denied by policy`) : ALLOW;
}

export function checkMcpServer(p: ResolvedPolicy, serverId: string): Decision {
  if (!p.mcp.allow) return ALLOW;
  return p.mcp.allow.includes(serverId) ? ALLOW : deny(`MCP server "${serverId}" is not in the allowlist`);
}

/** Is an outbound connection permitted? `isModelEndpoint` flags the configured LLM host. */
export function checkEgress(p: ResolvedPolicy, isModelEndpoint: boolean): Decision {
  if (p.network === 'on') return ALLOW;
  if (p.network === 'off') return deny('network egress is disabled by policy (network: off)');
  return isModelEndpoint ? ALLOW : deny('only the configured model endpoint is reachable (network: endpoint-only)');
}

export function checkCommand(p: ResolvedPolicy, commandLine: string): Decision {
  for (const pattern of p.commands.deny) {
    if (safeMatch(pattern, commandLine)) return deny(`command matches denylist: /${pattern}/`);
  }
  if (p.commands.allow) {
    const ok = p.commands.allow.some(pattern => safeMatch(pattern, commandLine));
    if (!ok) return deny('command is not in the allowlist');
  } else if (p.commands.defaultDeny) {
    return deny('command blocked by default-deny (no allowlist match)');
  }
  return ALLOW;
}

export function checkPath(p: ResolvedPolicy, filePath: string): Decision {
  const norm = filePath.replace(/\\/g, '/');
  for (const glob of p.paths.deny) {
    if (globToRegExp(glob).test(norm)) return deny(`path is denied by policy: ${glob}`);
  }
  if (p.paths.allow) {
    const ok = p.paths.allow.some(glob => globToRegExp(glob).test(norm));
    if (!ok) return deny('path is outside the policy allowlist');
  }
  return ALLOW;
}

/** Compile a command pattern to a RegExp; a malformed pattern never matches. */
function safeMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

/** Minimal glob → RegExp supporting `**`, `*`, and `?`. Anchored full-string match. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// ── Loading from disk ───────────────────────────────────────────────────────────

/** A policy source on disk, with its integrity hash for tamper-evidence. */
export type PolicySource = {
  /** Layer: machine-level (IT-pushed) or repo-level (team-committed). */
  layer: 'machine' | 'repo';
  path: string;
  present: boolean;
  /** SHA-256 of the raw file content; null when absent. */
  hash: string | null;
  /** Parse/validation error, if the file existed but could not be applied. */
  error?: string;
};

/** Resolved policy plus provenance: which files contributed and their hashes. */
export type LoadedPolicy = {
  policy: ResolvedPolicy;
  sources: PolicySource[];
  /** SHA-256 of the canonicalized resolved policy — recorded at run_start. */
  hash: string;
};

/** Machine-level policy path (IT-pushed). Overridable for tests. */
export function machinePolicyPath(): string {
  return process.env.DVALINCODE_POLICY_FILE ?? path.join(os.homedir(), '.dvalincode', 'policy.json');
}

/** Repo-level policy path (team-committed, narrowing only). */
export function repoPolicyPath(cwd: string): string {
  return path.join(cwd, 'dvalin.policy.json');
}

/** Hash of a resolved policy, for the audit run_start record and `trust`. */
export function policyHash(policy: ResolvedPolicy): string {
  return sha256(canonicalJSON(policy));
}

function readSource(layer: PolicySource['layer'], file: string): { source: PolicySource; parsed?: OrgPolicyInput } {
  if (!existsSync(file)) {
    return { source: { layer, path: file, present: false, hash: null } };
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    return { source: { layer, path: file, present: true, hash: null, error: errMsg(err) } };
  }
  const hash = sha256(raw);
  try {
    const parsed = policyFileSchema.parse(JSON.parse(raw));
    return { source: { layer, path: file, present: true, hash }, parsed };
  } catch (err) {
    // Fail-safe: a malformed policy is NOT silently treated as "allow everything".
    // It is skipped and the error surfaced loudly via run_start / `trust` so the
    // gatekeeper sees that a policy was intended but did not apply.
    return { source: { layer, path: file, present: true, hash, error: errMsg(err) } };
  }
}

/**
 * Discover and resolve the effective policy for a workspace.
 * Reads the machine layer then the repo layer; narrows them together.
 */
export function loadPolicy(cwd: string = process.cwd()): LoadedPolicy {
  const results = [
    readSource('machine', machinePolicyPath()),
    readSource('repo', repoPolicyPath(cwd)),
  ];
  const inputs = results.flatMap(r => (r.parsed ? [r.parsed] : []));
  const policy = resolvePolicy(inputs);
  return {
    policy,
    sources: results.map(r => r.source),
    hash: policyHash(policy),
  };
}

function errMsg(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return err instanceof Error ? err.message : String(err);
}
