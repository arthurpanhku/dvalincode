import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { findExecutable } from '../remediation/scannerSuite.js';
import {
  MCP_CLIENT_IDS,
  codexConfiguresServer,
  configuresServer,
  mcpClient,
  type JsonMcpClient,
  type McpClientId,
} from './install.js';

/**
 * Which coding agents are on this machine, and where Dvalin is already
 * configured for each.
 *
 * Detection only looks: a command on PATH, a directory the agent creates in the
 * home folder, or a macOS application bundle. Nothing is executed and nothing
 * is written.
 *
 * CC Switch is listed alongside the agents because it can sync an MCP server
 * into several of them at once; its own database is never read.
 */
export type AgentId = McpClientId | 'cc-switch';

export const AGENT_IDS: AgentId[] = [...MCP_CLIENT_IDS, 'cc-switch'];

type InstallSignals = {
  /** Executables on PATH that mean the agent is installed. */
  commands: string[];
  /** Directories, relative to the home folder, that the agent creates. */
  homeDirs: string[];
  /** macOS application bundles. */
  macApps: string[];
};

const SIGNALS: Record<AgentId, InstallSignals> = {
  codex: { commands: ['codex'], homeDirs: ['.codex'], macApps: [] },
  cursor: { commands: ['cursor'], homeDirs: ['.cursor'], macApps: ['Cursor.app'] },
  vscode: { commands: ['code'], homeDirs: ['.vscode'], macApps: ['Visual Studio Code.app'] },
  'claude-code': { commands: ['claude'], homeDirs: ['.claude'], macApps: [] },
  gemini: { commands: ['gemini'], homeDirs: ['.gemini'], macApps: [] },
  opencode: { commands: ['opencode'], homeDirs: [path.join('.config', 'opencode')], macApps: [] },
  'cc-switch': { commands: [], homeDirs: ['.cc-switch'], macApps: ['CC Switch.app'] },
};

export type DvalinLocation = {
  /** `local` is Claude Code's per-project entry in ~/.claude.json. */
  scope: 'project' | 'user' | 'local';
  file: string;
};

export type DetectedAgent = {
  id: AgentId;
  name: string;
  installed: boolean;
  /** What showed the agent is installed, e.g. `codex on PATH` or `~/.codex`. */
  evidence: string[];
  /** Where the Dvalin server is already configured. Always empty for CC Switch. */
  configured: DvalinLocation[];
  /** Config files that exist but could not be parsed, so `configured` may be incomplete. */
  unreadable: string[];
};

export type DetectOptions = {
  /** Project root whose project-level configs are checked. */
  root: string;
  home?: string;
  /** Where to look for macOS application bundles. Defaults to none off macOS. */
  applicationDirs?: string[];
  /** Server entry name to look for. */
  serverName?: string;
};

export async function detectAgents(options: DetectOptions): Promise<DetectedAgent[]> {
  const home = options.home ?? homedir();
  const applicationDirs = options.applicationDirs
    ?? (process.platform === 'darwin' ? ['/Applications', path.join(home, 'Applications')] : []);
  const serverName = options.serverName ?? 'dvalin';

  return Promise.all(AGENT_IDS.map(async (id): Promise<DetectedAgent> => {
    const evidence = await installEvidence(SIGNALS[id], home, applicationDirs);
    const status = id === 'cc-switch'
      ? { configured: [], unreadable: [] }
      : await dvalinStatus(id, options.root, home, serverName);
    return { id, name: agentName(id), installed: evidence.length > 0, evidence, ...status };
  }));
}

export function agentName(id: AgentId): string {
  return id === 'cc-switch' ? 'CC Switch' : mcpClient(id).name;
}

async function installEvidence(signals: InstallSignals, home: string, applicationDirs: string[]): Promise<string[]> {
  const evidence: string[] = [];
  for (const command of signals.commands) {
    if (await findExecutable(command)) evidence.push(`${command} on PATH`);
  }
  for (const dir of signals.homeDirs) {
    if (await isDirectory(path.join(home, dir))) evidence.push(`~/${dir.split(path.sep).join('/')}`);
  }
  for (const app of signals.macApps) {
    const bundle = applicationDirs.map(dir => path.join(dir, app));
    for (const candidate of bundle) {
      if (await isDirectory(candidate)) {
        evidence.push(candidate);
        break;
      }
    }
  }
  return evidence;
}

async function dvalinStatus(
  id: McpClientId,
  root: string,
  home: string,
  serverName: string,
): Promise<Pick<DetectedAgent, 'configured' | 'unreadable'>> {
  const configured: DvalinLocation[] = [];
  const unreadable: string[] = [];

  if (id === 'codex') {
    // `mcp-install codex` and CC Switch both write here; Codex's CLI owns the file.
    const file = path.join(home, '.codex', 'config.toml');
    const text = await readIfPresent(file);
    if (text !== undefined && codexConfiguresServer(text, serverName)) configured.push({ scope: 'user', file });
    return { configured, unreadable };
  }

  const client = mcpClient(id);
  for (const { scope, file } of configFiles(client, root, home)) {
    const config = await readJsonObject(file, unreadable);
    if (config && configuresServer(config, client, serverName)) configured.push({ scope, file });
  }

  if (id === 'claude-code') {
    // `claude mcp add` keeps user- and local-scope servers in ~/.claude.json;
    // the local ones sit under the project's absolute path.
    const file = path.join(home, '.claude.json');
    const state = await readJsonObject(file, unreadable);
    if (state && configuresServer(state, client, serverName)) configured.push({ scope: 'user', file });
    const projects = state?.projects;
    const project = isRecord(projects) ? projects[root] : undefined;
    if (configuresServer(project, client, serverName)) configured.push({ scope: 'local', file });
  }

  return { configured, unreadable };
}

function configFiles(client: JsonMcpClient, root: string, home: string): DvalinLocation[] {
  const files: DvalinLocation[] = [{ scope: 'project', file: path.join(root, client.projectPath) }];
  if (client.userPath) files.push({ scope: 'user', file: path.join(home, client.userPath) });
  // OpenCode also reads `opencode.jsonc` beside `opencode.json`, and its docs
  // default to the `.jsonc` name.
  if (client.id === 'opencode') return files.flatMap(entry => [entry, { ...entry, file: `${entry.file}c` }]);
  return files;
}

/** A missing or empty file is "not configured"; one that will not parse is recorded as unreadable. */
async function readJsonObject(file: string, unreadable: string[]): Promise<Record<string, unknown> | undefined> {
  const text = await readIfPresent(file);
  if (text === undefined || !text.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Comments, trailing commas, or a half-written file: say so rather than guess.
  }
  unreadable.push(file);
  return undefined;
}

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
