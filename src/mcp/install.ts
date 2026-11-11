import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Where each editor keeps its MCP configuration, and what shape it expects.
 *
 * The shapes are not the same, and the difference is silent: VS Code keys its
 * servers under `servers`, Cursor under `mcpServers`. Putting Cursor's key in a
 * VS Code file produces no error and no server — the tools simply never appear,
 * which is a bad afternoon for whoever tries it. Encoding the difference here
 * is the point of this module.
 *
 * Every entry below was read from that editor's own documentation. An editor
 * whose format could not be confirmed is deliberately absent: a wrong config is
 * worse than none, because it fails quietly.
 */
export type McpClientId = 'codex' | 'cursor' | 'vscode' | 'claude-code' | 'gemini' | 'opencode';

export const MCP_CLIENT_IDS: McpClientId[] = ['codex', 'cursor', 'vscode', 'claude-code', 'gemini', 'opencode'];

export type JsonMcpClientId = Exclude<McpClientId, 'codex'>;

export type JsonMcpClient = {
  id: JsonMcpClientId;
  name: string;
  /** Key the servers live under in the config file. */
  serversKey: 'servers' | 'mcpServers' | 'mcp';
  /** Path relative to the project root. */
  projectPath: string;
  /** Path relative to the user's home directory, when the editor has one. */
  userPath?: string;
  /** Anything the user still has to do after the file is written. */
  followUp?: string;
};

export type CodexMcpClient = {
  id: 'codex';
  name: 'Codex';
  installMethod: 'codex-cli';
  followUp: string;
};

export type McpClient = JsonMcpClient | CodexMcpClient;

const CLIENTS: Record<McpClientId, McpClient> = {
  codex: {
    id: 'codex',
    name: 'Codex',
    installMethod: 'codex-cli',
    followUp: 'Start a new Codex session, then ask it to run `dvalin_scan` on your uncommitted changes.',
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    serversKey: 'mcpServers',
    projectPath: path.join('.cursor', 'mcp.json'),
    userPath: path.join('.cursor', 'mcp.json'),
  },
  vscode: {
    id: 'vscode',
    name: 'VS Code',
    // Not `mcpServers`. VS Code is the odd one out, and the reason this module
    // exists rather than a single documented snippet.
    serversKey: 'servers',
    projectPath: path.join('.vscode', 'mcp.json'),
    followUp: 'VS Code keeps its user-level MCP config inside the profile folder; run the "MCP: Open User Configuration" command to edit it.',
  },
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    serversKey: 'mcpServers',
    projectPath: '.mcp.json',
    followUp: 'A .mcp.json arriving with a repository is untrusted until approved. Run `claude` once in the project and approve it, or use `claude mcp add --scope local` for your machine only.',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    // settings.json holds every other Gemini CLI setting too; the merge touches
    // only `mcpServers`.
    serversKey: 'mcpServers',
    projectPath: path.join('.gemini', 'settings.json'),
    userPath: path.join('.gemini', 'settings.json'),
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    // Not `{ command, args }` under `mcpServers`: OpenCode wants `type: "local"`
    // and the whole command line in one array. See openCodeServerEntry.
    serversKey: 'mcp',
    projectPath: 'opencode.json',
    userPath: path.join('.config', 'opencode', 'opencode.json'),
  },
};

export function mcpClient(id: 'codex'): CodexMcpClient;
export function mcpClient(id: JsonMcpClientId): JsonMcpClient;
export function mcpClient(id: McpClientId): McpClient;
export function mcpClient(id: McpClientId): McpClient {
  return CLIENTS[id];
}

export type McpInstallTarget = { client: JsonMcpClient; file: string };

export function resolveInstallTarget(id: McpClientId, root: string, global: boolean): McpInstallTarget {
  const client = mcpClient(id);
  if (client.id === 'codex') {
    throw new Error('Codex MCP configuration is managed by `codex mcp add`, not by writing JSON.');
  }
  if (!global) return { client, file: path.join(root, client.projectPath) };
  if (!client.userPath) {
    throw new Error(`${client.name} has no user-level file this command can write. ${client.followUp ?? ''}`.trim());
  }
  return { client, file: path.join(homedir(), client.userPath) };
}

/** The server entry itself, which is the same everywhere the key is not. */
export function dvalinServerEntry(workspace: string): Record<string, unknown> {
  return {
    command: 'npx',
    args: ['-y', 'dvalincode', 'mcp-serve', '--workspace', workspace],
  };
}

/** Arguments for Codex's own config writer, which safely updates config.toml. */
export function codexMcpAddArgs(workspace: string, serverName = 'dvalin'): string[] {
  return ['mcp', 'add', serverName, '--', 'npx', '-y', 'dvalincode', 'mcp-serve', '--workspace', workspace];
}

export type MergeOutcome = {
  config: Record<string, unknown>;
  /** `added` when there was no dvalin entry, `replaced` when one was overwritten. */
  action: 'added' | 'replaced' | 'unchanged';
};

/**
 * Merge the Dvalin server into whatever is already there.
 *
 * An editor's MCP file usually belongs to the whole team, not to this tool, so
 * the other servers in it survive untouched and key order is preserved.
 */
export function mergeDvalinServer(
  existing: Record<string, unknown> | undefined,
  client: JsonMcpClient,
  workspace: string,
  serverName = 'dvalin',
): MergeOutcome {
  if (client.id === 'opencode') return mergeOpenCodeServer(existing, workspace, serverName);
  const config: Record<string, unknown> = { ...(existing ?? {}) };
  const servers = { ...(asRecord(config[client.serversKey]) ?? {}) };
  const entry = dvalinServerEntry(workspace);
  const previous = servers[serverName];

  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) {
    return { config: { ...config, [client.serversKey]: servers }, action: 'unchanged' };
  }

  servers[serverName] = entry;
  config[client.serversKey] = servers;
  return { config, action: previous === undefined ? 'added' : 'replaced' };
}

/**
 * OpenCode's entry: `type: "local"` and the command line as one array.
 *
 * Written in OpenCode's V1 shape (`mcp.<name>` with `enabled`) because OpenCode
 * V2 still reads it, while V2's native `mcp.servers` shape is invisible to a V1
 * install. A server already under `mcp.servers` is updated where it is, in the
 * V2 shape, so one file never defines it twice.
 */
export function openCodeServerEntry(workspace: string, v2 = false): Record<string, unknown> {
  const { command, args } = dvalinServerEntry(workspace) as { command: string; args: string[] };
  return v2
    ? { type: 'local', command: [command, ...args] }
    : { type: 'local', command: [command, ...args], enabled: true };
}

function mergeOpenCodeServer(
  existing: Record<string, unknown> | undefined,
  workspace: string,
  serverName: string,
): MergeOutcome {
  const config: Record<string, unknown> = { ...(existing ?? {}) };
  const mcp = { ...(asRecord(config.mcp) ?? {}) };
  const v2Servers = asRecord(mcp.servers);
  const inV2 = v2Servers?.[serverName] !== undefined;
  const servers = inV2 ? { ...v2Servers } : mcp;
  const entry = openCodeServerEntry(workspace, inV2);
  const previous = servers[serverName];

  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) {
    return { config, action: 'unchanged' };
  }

  servers[serverName] = entry;
  if (inV2) mcp.servers = servers;
  config.mcp = mcp;
  return { config, action: previous === undefined ? 'added' : 'replaced' };
}

/** Whether a parsed config already defines the server, in any shape the client reads. */
export function configuresServer(config: unknown, client: JsonMcpClient, serverName = 'dvalin'): boolean {
  const servers = asRecord(asRecord(config)?.[client.serversKey]);
  if (!servers) return false;
  if (servers[serverName] !== undefined) return true;
  return client.id === 'opencode' && asRecord(servers.servers)?.[serverName] !== undefined;
}

/** Whether Codex's config.toml already has a `[mcp_servers.<name>]` table. */
export function codexConfiguresServer(toml: string, serverName = 'dvalin'): boolean {
  const name = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${name}"|'${name}'|${name})\\s*\\]`, 'm').test(toml);
}

/** The agents CC Switch can sync an MCP server into, under CC Switch's app ids. */
export const CC_SWITCH_APPS: Partial<Record<McpClientId, string>> = {
  'claude-code': 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
};

/**
 * A `ccswitch://` link that hands the Dvalin server to CC Switch.
 *
 * CC Switch shows what the link carries and asks before importing, then writes
 * the server into every app listed, in each app's own format. The shape is CC
 * Switch's deep link protocol: `config` is Base64 of `{"mcpServers": {...}}`,
 * and every value is URL-encoded on top of that. A server CC Switch already has
 * under the same name keeps its config; only the new apps are added to it.
 */
export function ccSwitchImportLink(apps: string[], workspace: string, serverName = 'dvalin'): string {
  const config = JSON.stringify({ mcpServers: { [serverName]: dvalinServerEntry(workspace) } });
  const params = new URLSearchParams({
    resource: 'mcp',
    apps: apps.join(','),
    config: Buffer.from(config, 'utf8').toString('base64'),
  });
  return `ccswitch://v1/import?${params}`;
}

export function renderConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
