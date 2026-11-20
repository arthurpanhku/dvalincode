import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ccSwitchTargets, planSkillStep, registerAgentsCommand, selectAgents } from '../src/commands/agents.js';
import { CLAUDE_SKILL_SOURCE, bundledClaudeSkill } from '../src/mcp/agentSkills.js';
import { detectAgents, type DetectedAgent } from '../src/mcp/agents.js';
import { dvalinServerEntry } from '../src/mcp/install.js';
import { VERSION } from '../src/version.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The standalone Claude Code skill, as the repository has it. */
const shipped = readFileSync(path.join(repoRoot, CLAUDE_SKILL_SOURCE), 'utf8');

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

function skillFile(base: string): string {
  return path.join(base, '.claude', 'skills', 'dvalin-security-scan', 'SKILL.md');
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

  it('finds the skill in either Claude Code skills folder, and in Codex as the dvalin-security plugin', async () => {
    await put(skillFile(root), shipped);
    // A different skill under the same name still occupies the name.
    await put(skillFile(home), '---\nname: dvalin-security-scan\n---\nSomeone else\'s.\n');
    await put(path.join(home, '.codex', 'config.toml'), '[plugins."dvalin-security@dvalincode-local"]\nenabled = true\n');

    expect((await agent('claude-code')).skill).toEqual([
      { scope: 'project', file: skillFile(root) },
      { scope: 'user', file: skillFile(home) },
    ]);
    expect((await agent('codex')).skill).toEqual([{ scope: 'user', file: path.join(home, '.codex', 'config.toml') }]);
  });

  it('reports the skill missing for Claude Code and Codex, and has none for the other agents', async () => {
    // A marketplace on its own installs nothing.
    await put(path.join(home, '.codex', 'config.toml'), '[marketplaces.dvalincode-local]\nsource_type = "git"\n');

    const found = await detect();

    expect(found.filter(candidate => candidate.skill).map(candidate => [candidate.id, candidate.skill]))
      .toEqual([['codex', []], ['claude-code', []]]);
  });
});

describe('selectAgents', () => {
  it('picks every installed agent that has no Dvalin yet, and never CC Switch on its own', async () => {
    await onPath('codex');
    await onPath('code');
    await mkdir(path.join(home, '.claude'));
    await mkdir(path.join(home, '.cc-switch'));
    await put(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { dvalin: {} } }));
    await put(skillFile(root), shipped);

    expect(selectAgents(await detect(), [])).toEqual(['codex', 'vscode']);
  });

  it('also picks an agent that has the server but not the skill', async () => {
    await onPath('claude');
    await put(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { dvalin: {} } }));

    expect(selectAgents(await detect(), [])).toEqual(['claude-code']);
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

describe('planSkillStep for Claude Code', () => {
  function plan(options: { global?: boolean; shipped?: string | undefined } = {}) {
    return planSkillStep('claude-code', { root, home, global: Boolean(options.global), shipped: 'shipped' in options ? options.shipped : shipped });
  }

  it('plans the standalone skill into the project, and writes it only when applied', async () => {
    const step = await plan();

    expect(step.summary).toContain('write .claude/skills/dvalin-security-scan/SKILL.md (the standalone Claude Code skill)');
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
    await step.apply!();
    expect(readFileSync(skillFile(root), 'utf8')).toBe(shipped);
  });

  it('writes it into the home folder with --global', async () => {
    await (await plan({ global: true })).apply!();

    expect(readFileSync(skillFile(home), 'utf8')).toBe(shipped);
    expect(existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('skips a skill already there with the same text, line endings aside', async () => {
    await put(skillFile(root), shipped.replaceAll('\n', '\r\n'));

    const step = await plan();

    expect(step.summary).toBe('skill dvalin-security-scan: already installed: .claude/skills/dvalin-security-scan/SKILL.md');
    expect(step.apply).toBeUndefined();
  });

  it('leaves a different skill of the same name alone, and says where this version is', async () => {
    await put(skillFile(root), '---\nname: dvalin-security-scan\n---\nA local edit.\n');

    const step = await plan();

    expect(step.summary).toContain('already exists and differs from this version\'s; left as is');
    expect(step.details?.join('\n')).toContain(`https://github.com/arthurpanhku/dvalincode/blob/v${VERSION}/${CLAUDE_SKILL_SOURCE}`);
    expect(step.apply).toBeUndefined();
    expect(readFileSync(skillFile(root), 'utf8')).toContain('A local edit.');
  });

  it('fails rather than overwrite a skill written between the plan and the apply', async () => {
    const step = await plan();
    await put(skillFile(root), 'written meanwhile');

    await expect(step.apply!()).rejects.toThrow(/EEXIST/);
    expect(readFileSync(skillFile(root), 'utf8')).toBe('written meanwhile');
  });

  it('points a build without a copy of the skill to the npm package', async () => {
    const step = await plan({ shipped: undefined });

    expect(step.summary).toContain('`npx dvalincode agents connect claude-code --yes` installs it');
    expect(step.apply).toBeUndefined();
  });
});

describe('planSkillStep for Codex', () => {
  let log: string;
  const config = () => path.join(home, '.codex', 'config.toml');
  const plan = () => planSkillStep('codex', { root, home, global: false, shipped });

  async function fakeCodex(script: string): Promise<void> {
    await writeFile(path.join(bin, 'codex'), `#!/bin/sh\n${script}\n`, 'utf8');
    await chmod(path.join(bin, 'codex'), 0o755);
  }

  function calls(): string[] {
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  }

  beforeEach(async () => {
    log = path.join(base, 'codex-calls.log');
    vi.stubEnv('CODEX_CALLS', log);
    await fakeCodex('printf \'%s\\n\' "$*" >> "$CODEX_CALLS"');
  });

  it("installs the plugin from GitHub at this release's tag with Codex's own commands, only when applied", async () => {
    const marketplaceAdd = `plugin marketplace add arthurpanhku/dvalincode --ref v${VERSION} --sparse .agents/plugins --sparse integrations/dvalin-security`;
    const step = await plan();

    expect(step.summary).toContain(`install the dvalin-security plugin from GitHub at v${VERSION}`);
    expect(step.details?.map(line => line.trim())).toEqual([`codex ${marketplaceAdd}`, 'codex plugin add dvalin-security@dvalincode-local']);
    expect(calls()).toEqual([]);
    await step.apply!();
    expect(calls()).toEqual([marketplaceAdd, 'plugin add dvalin-security@dvalincode-local']);
  });

  it('installs from a dvalincode-local marketplace Codex already has, which Codex would refuse to add again', async () => {
    await put(config(), '[marketplaces.dvalincode-local]\nsource_type = "local"\nsource = "/src/dvalincode"\n');

    await (await plan()).apply!();

    expect(calls()).toEqual(['plugin add dvalin-security@dvalincode-local']);
  });

  it('leaves an installed plugin alone', async () => {
    await put(config(), "[plugins.'dvalin-security@dvalincode-local']\nenabled = true\n");

    const step = await plan();

    expect(step.summary).toBe('skill dvalin-security-scan: already installed: Codex plugin dvalin-security@dvalincode-local');
    expect(step.apply).toBeUndefined();
  });

  it('passes on what Codex said when it refuses', async () => {
    await fakeCodex('echo "marketplace \'dvalincode-local\' is already added from a different source" >&2\nexit 1');

    await expect((await plan()).apply!()).rejects.toThrow(/^codex plugin marketplace add .* failed: marketplace 'dvalincode-local' is already added/);
  });
});

describe('agents connect', () => {
  let output: string[];

  beforeEach(() => {
    output = [];
    vi.spyOn(console, 'log').mockImplementation((...line: unknown[]) => void output.push(line.join(' ')));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    vi.stubEnv('HOME', home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function connect(...args: string[]): Promise<string> {
    const exitCode = process.exitCode;
    output.length = 0;
    const program = new Command();
    registerAgentsCommand(program);
    try {
      await program.parseAsync(['agents', 'connect', ...args], { from: 'user' });
      expect(process.exitCode).toBe(exitCode);
    } finally {
      process.exitCode = exitCode;
    }
    return output.join('\n');
  }

  it('plans the skill for a Claude Code project without writing it, and installs it with --yes', async () => {
    await onPath('claude');

    expect(await connect()).toContain('skill dvalin-security-scan: write .claude/skills/dvalin-security-scan/SKILL.md');
    expect(existsSync(path.join(root, '.claude'))).toBe(false);

    expect(await connect('--yes')).toContain(`Added skill dvalin-security-scan: ${skillFile(root)}`);
    expect(readFileSync(skillFile(root), 'utf8')).toBe(shipped);
  });

  it('adds only the skill to an agent picked for lacking it, leaving its server where it is', async () => {
    await onPath('claude');
    const userConfig = path.join(home, '.claude.json');
    await put(userConfig, JSON.stringify({ mcpServers: { dvalin: dvalinServerEntry('.') } }));

    expect(await connect('--yes')).toContain('already connected: user ~/.claude.json');
    expect(existsSync(path.join(root, '.mcp.json'))).toBe(false);
    expect(readFileSync(skillFile(root), 'utf8')).toBe(shipped);
  });
});

describe('the npm package', () => {
  it('ships the skill agents connect installs, which is read from there', async () => {
    const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

    expect(packageJson.files).toContain(CLAUDE_SKILL_SOURCE);
    expect(await bundledClaudeSkill()).toBe(shipped);
  });

  it('installs a skill that is a single file, so writing SKILL.md installs all of it', () => {
    expect(readdirSync(path.dirname(path.join(repoRoot, CLAUDE_SKILL_SOURCE)))).toEqual(['SKILL.md']);
  });
});
