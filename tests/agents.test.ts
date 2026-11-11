import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ccSwitchTargets, selectAgents } from '../src/commands/agents.js';
import { detectAgents, type DetectedAgent } from '../src/mcp/agents.js';
import { dvalinServerEntry } from '../src/mcp/install.js';

let base: string;
let home: string;
let root: string;
let bin: string;
let apps: string;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'dvalin-agents-'));
  home = path.join(base, 'home');
  root = path.join(base, 'repo');
  bin = path.join(base, 'bin');
  apps = path.join(base, 'Applications');
  for (const dir of [home, root, bin, apps]) await mkdir(dir, { recursive: true });
  // Only the fake commands below are on PATH, whatever this machine has installed.
  vi.stubEnv('PATH', bin);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function onPath(command: string): Promise<void> {
  const file = path.join(bin, command);
  await writeFile(file, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(file, 0o755);
}

function detect(serverName?: string): Promise<DetectedAgent[]> {
  return detectAgents({ root, home, applicationDirs: [apps], serverName });
}

async function agent(id: DetectedAgent['id'], serverName?: string): Promise<DetectedAgent> {
  return (await detect(serverName)).find(candidate => candidate.id === id)!;
}

describe('detectAgents', () => {
  it('finds nothing on a machine with none of the agents', async () => {
    const found = await detect();

    expect(found.map(candidate => candidate.id)).toEqual(['codex', 'cursor', 'vscode', 'claude-code', 'gemini', 'opencode', 'cc-switch']);
    expect(found.filter(candidate => candidate.installed)).toEqual([]);
  });

  it('counts a command on PATH, a directory the agent creates, or an app bundle as installed', async () => {
    await onPath('claude');
    await mkdir(path.join(home, '.codex'));
    await mkdir(path.join(apps, 'Cursor.app'));
    await mkdir(path.join(home, '.config', 'opencode'), { recursive: true });
    await mkdir(path.join(home, '.cc-switch'));

    const found = new Map((await detect()).map(candidate => [candidate.id, candidate]));

    expect(found.get('claude-code')).toMatchObject({ installed: true, evidence: ['claude on PATH'] });
    expect(found.get('codex')).toMatchObject({ installed: true, evidence: ['~/.codex'] });
    expect(found.get('cursor')).toMatchObject({ installed: true, evidence: [path.join(apps, 'Cursor.app')] });
    expect(found.get('opencode')).toMatchObject({ installed: true, evidence: ['~/.config/opencode'] });
    expect(found.get('cc-switch')).toMatchObject({ installed: true, evidence: ['~/.cc-switch'] });
    expect(found.get('vscode')?.installed).toBe(false);
    expect(found.get('gemini')?.installed).toBe(false);
  });

  it('finds Dvalin in project and user configs, each under the key that agent reads', async () => {
    await put(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { dvalin: dvalinServerEntry('.') } }));
    // VS Code ignores `mcpServers`, so an entry there does not connect anything.
    await put(path.join(root, '.vscode', 'mcp.json'), JSON.stringify({ mcpServers: { dvalin: dvalinServerEntry('.') } }));
    await put(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Default', mcpServers: { dvalin: {} } }));
    await put(path.join(home, '.codex', 'config.toml'), 'model = "o3"\n\n[mcp_servers.dvalin]\ncommand = "npx"\n');

    expect((await agent('claude-code')).configured).toEqual([{ scope: 'project', file: path.join(root, '.mcp.json') }]);
    expect((await agent('vscode')).configured).toEqual([]);
    expect((await agent('gemini')).configured).toEqual([{ scope: 'user', file: path.join(home, '.gemini', 'settings.json') }]);
    expect((await agent('codex')).configured).toEqual([{ scope: 'user', file: path.join(home, '.codex', 'config.toml') }]);
  });

  it("reads Claude Code's user scope and this project's local scope from ~/.claude.json", async () => {
    const file = path.join(home, '.claude.json');
    await put(file, JSON.stringify({
      mcpServers: { dvalin: {} },
      projects: {
        [root]: { mcpServers: { dvalin: {} } },
        [path.join(base, 'other')]: { mcpServers: { unrelated: {} } },
      },
    }));

    expect((await agent('claude-code')).configured).toEqual([
      { scope: 'user', file },
      { scope: 'local', file },
    ]);
  });

  it('finds an OpenCode server in the V2 shape, in opencode.jsonc', async () => {
    const file = path.join(root, 'opencode.jsonc');
    await put(file, JSON.stringify({ mcp: { servers: { dvalin: { type: 'local', command: ['npx'] } } } }));

    expect((await agent('opencode')).configured).toEqual([{ scope: 'project', file }]);
  });

  /** "Not configured" would be a guess; the file might well name Dvalin. */
  it('reports a config it cannot parse, rather than calling it unconfigured', async () => {
    const file = path.join(home, '.config', 'opencode', 'opencode.jsonc');
    await put(file, '{\n  // OpenCode allows comments here\n  "mcp": {},\n}\n');

    const opencode = await agent('opencode');

    expect(opencode.configured).toEqual([]);
    expect(opencode.unreadable).toEqual([file]);
  });

  it('looks for the server name it is given', async () => {
    await put(path.join(root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'dvalin-api': {} } }));

    expect((await agent('cursor')).configured).toEqual([]);
    expect((await agent('cursor', 'dvalin-api')).configured).toHaveLength(1);
  });
});

describe('selectAgents', () => {
  it('picks every installed agent that has no Dvalin yet, and never CC Switch on its own', async () => {
    await onPath('codex');
    await onPath('code');
    await mkdir(path.join(home, '.claude'));
    await mkdir(path.join(home, '.cc-switch'));
    await put(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { dvalin: {} } }));

    expect(selectAgents(await detect(), [])).toEqual(['codex', 'vscode']);
  });

  it('takes exactly the agents named, once each, whether or not they were found', async () => {
    expect(selectAgents(await detect(), ['gemini', 'cc-switch', 'gemini'])).toEqual(['gemini', 'cc-switch']);
  });

  it('rejects an agent it has no verified format for', () => {
    expect(() => selectAgents([], ['windsurf'])).toThrow(/Unknown agent 'windsurf'/);
  });
});

describe('ccSwitchTargets', () => {
  it('hands CC Switch only the installed agents it can sync MCP into', async () => {
    await onPath('claude');
    await onPath('cursor'); // CC Switch does not manage Cursor.
    await mkdir(path.join(home, '.gemini'));

    expect(ccSwitchTargets(await detect()).map(candidate => candidate.id)).toEqual(['claude-code', 'gemini']);
  });
});
