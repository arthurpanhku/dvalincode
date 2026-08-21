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
export type McpClientId = 'cursor' | 'vscode' | 'claude-code';

export const MCP_CLIENT_IDS: McpClientId[] = ['cursor', 'vscode', 'claude-code'];

export type McpClient = {
  id: McpClientId;
  name: string;
  /** Key the servers live under in the config file. */
  serversKey: 'servers' | 'mcpServers';
  /** Path relative to the project root. */
  projectPath: string;
  /** Path relative to the user's home directory, when the editor has one. */
  userPath?: string;
  /** Anything the user still has to do after the file is written. */
  followUp?: string;
};

const CLIENTS: Record<McpClientId, McpClient> = {
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
};

export function mcpClient(id: McpClientId): McpClient {
  return CLIENTS[id];
}

export type McpInstallTarget = { client: McpClient; file: string };

export function resolveInstallTarget(id: McpClientId, root: string, global: boolean): McpInstallTarget {
  const client = mcpClient(id);
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
  client: McpClient,
  workspace: string,
  serverName = 'dvalin',
): MergeOutcome {
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

export function renderConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
