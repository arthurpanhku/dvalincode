import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CC_SWITCH_APPS,
  MCP_CLIENT_IDS,
  ccSwitchImportLink,
  codexConfiguresServer,
  codexMcpAddArgs,
  configuresServer,
  dvalinServerEntry,
  mcpClient,
  mergeDvalinServer,
  openCodeServerEntry,
  renderConfig,
  resolveInstallTarget,
} from '../src/mcp/install.js';

describe('editor MCP config shapes', () => {
  /**
   * The reason this module exists. Getting these two backwards produces a file
   * the editor accepts and ignores: no error, no server, no tools.
   */
  it('keys VS Code under `servers` and Cursor under `mcpServers`', () => {
    expect(mcpClient('vscode').serversKey).toBe('servers');
    expect(mcpClient('cursor').serversKey).toBe('mcpServers');
    expect(mcpClient('claude-code').serversKey).toBe('mcpServers');
  });

  it('lets the Codex CLI own its TOML config instead of trying to merge it as JSON', () => {
    expect(mcpClient('codex').installMethod).toBe('codex-cli');
    expect(codexMcpAddArgs('packages/api', 'dvalin-api')).toEqual([
      'mcp', 'add', 'dvalin-api', '--',
      'npx', '-y', 'dvalincode', 'mcp-serve', '--workspace', 'packages/api',
    ]);
    expect(() => resolveInstallTarget('codex', '/repo', false)).toThrow(/codex mcp add/i);
  });

  it('writes each editor to the path that editor actually reads', () => {
    expect(mcpClient('cursor').projectPath).toBe(path.join('.cursor', 'mcp.json'));
    expect(mcpClient('vscode').projectPath).toBe(path.join('.vscode', 'mcp.json'));
    expect(mcpClient('claude-code').projectPath).toBe('.mcp.json');
    expect(mcpClient('gemini').projectPath).toBe(path.join('.gemini', 'settings.json'));
    expect(mcpClient('opencode').projectPath).toBe('opencode.json');
  });

  it("keys Gemini CLI under `mcpServers` in the settings file it shares with Gemini's other settings", () => {
    expect(mcpClient('gemini').serversKey).toBe('mcpServers');
    expect(mcpClient('gemini').userPath).toBe(path.join('.gemini', 'settings.json'));
  });

  it("keeps OpenCode's user config where OpenCode looks for it", () => {
    expect(mcpClient('opencode').serversKey).toBe('mcp');
    expect(mcpClient('opencode').userPath).toBe(path.join('.config', 'opencode', 'opencode.json'));
  });

  it('runs the server through npx, so nothing has to be installed first', () => {
    expect(dvalinServerEntry('.')).toEqual({
      command: 'npx',
      args: ['-y', 'dvalincode', 'mcp-serve', '--workspace', '.'],
    });
  });

  it('bounds the server to the workspace it was given', () => {
    expect(dvalinServerEntry('packages/api').args).toContain('packages/api');
  });
});

describe('resolveInstallTarget', () => {
  it('puts the project config inside the project', () => {
    const target = resolveInstallTarget('cursor', '/repo', false);

    expect(target.file).toBe(path.join('/repo', '.cursor', 'mcp.json'));
  });

  it('puts the global config in the home directory, not the project', () => {
    const target = resolveInstallTarget('cursor', '/repo', true);

    expect(target.file).not.toContain(path.join('/repo'));
    expect(target.file.endsWith(path.join(path.sep, '.cursor', 'mcp.json'))).toBe(true);
  });

  /**
   * VS Code keeps user-level MCP config inside the profile folder, which is not
   * a stable path this command can compute. Refusing beats writing a file the
   * editor will never read.
   */
  it('refuses a global write for an editor whose user path is not a fixed file', () => {
    expect(() => resolveInstallTarget('vscode', '/repo', true)).toThrow(/no user-level file/);
  });
});

describe('mergeDvalinServer', () => {
  it('creates the config when there is nothing there yet', () => {
    const { config, action } = mergeDvalinServer(undefined, mcpClient('cursor'), '.');

    expect(action).toBe('added');
    expect(config).toEqual({ mcpServers: { dvalin: dvalinServerEntry('.') } });
  });

  /** An editor's MCP file belongs to the team, not to this tool. */
  it('leaves every other server in the file untouched', () => {
    const existing = {
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'github-mcp'] },
      },
      someOtherSetting: true,
    };

    const { config } = mergeDvalinServer(existing, mcpClient('cursor'), '.');

    expect(config).toEqual({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'github-mcp'] },
        dvalin: dvalinServerEntry('.'),
      },
      someOtherSetting: true,
    });
  });

  it('does not touch the file when the entry is already exactly right', () => {
    const existing = { servers: { dvalin: dvalinServerEntry('.') } };

    expect(mergeDvalinServer(existing, mcpClient('vscode'), '.').action).toBe('unchanged');
  });

  it('replaces an entry that points somewhere else, and says that it did', () => {
    const existing = { mcpServers: { dvalin: { command: 'node', args: ['old.js'] } } };

    const { config, action } = mergeDvalinServer(existing, mcpClient('cursor'), '.');

    expect(action).toBe('replaced');
    expect(config.mcpServers).toEqual({ dvalin: dvalinServerEntry('.') });
  });

  it('honours a custom entry name so two workspaces can coexist', () => {
    const { config } = mergeDvalinServer(undefined, mcpClient('cursor'), 'api', 'dvalin-api');

    expect(Object.keys(config.mcpServers as object)).toEqual(['dvalin-api']);
  });

  it('does not confuse the two key names when a file already uses the other one', () => {
    // A repository that configures both editors keeps both keys in play; each
    // command must write only its own.
    const existing = { mcpServers: { other: { command: 'x', args: [] } } };

    const { config } = mergeDvalinServer(existing, mcpClient('vscode'), '.');

    expect(config.mcpServers).toEqual({ other: { command: 'x', args: [] } });
    expect(config.servers).toEqual({ dvalin: dvalinServerEntry('.') });
  });

  it('survives a file whose servers key holds something that is not an object', () => {
    const { config } = mergeDvalinServer({ mcpServers: 'nonsense' }, mcpClient('cursor'), '.');

    expect(config.mcpServers).toEqual({ dvalin: dvalinServerEntry('.') });
  });
});

describe('OpenCode', () => {
  const npxLine = ['npx', '-y', 'dvalincode', 'mcp-serve', '--workspace', '.'];

  /**
   * OpenCode V2 still reads the V1 shape; V1 cannot read V2's `mcp.servers`.
   * Writing V1 is the one shape both versions see.
   */
  it('writes the V1 shape: a local server with the whole command line in one array', () => {
    const { config, action } = mergeDvalinServer(undefined, mcpClient('opencode'), '.');

    expect(action).toBe('added');
    expect(config).toEqual({ mcp: { dvalin: { type: 'local', command: npxLine, enabled: true } } });
  });

  it('keeps the rest of opencode.json, including the other servers', () => {
    const existing = {
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4-6',
      mcp: { docs: { type: 'remote', url: 'https://docs.example/mcp' } },
    };

    const { config } = mergeDvalinServer(existing, mcpClient('opencode'), '.');

    expect(config).toEqual({ ...existing, mcp: { ...existing.mcp, dvalin: openCodeServerEntry('.') } });
  });

  it('updates a server already in the V2 `mcp.servers` shape where it is, instead of defining it twice', () => {
    const existing = { mcp: { servers: { dvalin: { type: 'local', command: ['node', 'old.js'] } } } };

    const { config, action } = mergeDvalinServer(existing, mcpClient('opencode'), '.');

    expect(action).toBe('replaced');
    expect(config).toEqual({ mcp: { servers: { dvalin: { type: 'local', command: npxLine } } } });
  });

  it('does not touch the file when the entry is already exactly right', () => {
    const existing = { mcp: { dvalin: openCodeServerEntry('.') } };

    expect(mergeDvalinServer(existing, mcpClient('opencode'), '.').action).toBe('unchanged');
  });
});

describe('configuresServer', () => {
  it("looks only under the client's own key, as the client itself does", () => {
    expect(configuresServer({ servers: { dvalin: {} } }, mcpClient('vscode'))).toBe(true);
    expect(configuresServer({ mcpServers: { dvalin: {} } }, mcpClient('vscode'))).toBe(false);
    expect(configuresServer({ mcpServers: { 'dvalin-api': {} } }, mcpClient('cursor'), 'dvalin-api')).toBe(true);
  });

  it('finds an OpenCode server in either the V1 or the V2 shape', () => {
    expect(configuresServer({ mcp: { dvalin: {} } }, mcpClient('opencode'))).toBe(true);
    expect(configuresServer({ mcp: { servers: { dvalin: {} } } }, mcpClient('opencode'))).toBe(true);
    expect(configuresServer({ mcp: { servers: {} } }, mcpClient('opencode'))).toBe(false);
  });

  it('treats anything that is not an object as not configured', () => {
    expect(configuresServer(undefined, mcpClient('cursor'))).toBe(false);
    expect(configuresServer({ mcpServers: 'nonsense' }, mcpClient('cursor'))).toBe(false);
  });
});

describe('codexConfiguresServer', () => {
  it('recognises the table Codex writes, bare or quoted', () => {
    expect(codexConfiguresServer('model = "o3"\n\n[mcp_servers.dvalin]\ncommand = "npx"\n')).toBe(true);
    expect(codexConfiguresServer('[mcp_servers."dvalin"]\n')).toBe(true);
    expect(codexConfiguresServer("  [ mcp_servers . 'dvalin' ]\n")).toBe(true);
  });

  it('does not mistake another server, or a commented-out one, for it', () => {
    expect(codexConfiguresServer('[mcp_servers.dvalin-api]\n')).toBe(false);
    expect(codexConfiguresServer('# [mcp_servers.dvalin]\n')).toBe(false);
    expect(codexConfiguresServer('[mcp_servers.dvalin-api]\n', 'dvalin-api')).toBe(true);
  });
});

describe('ccSwitchImportLink', () => {
  function decode(link: string): { params: URLSearchParams; config: unknown } {
    expect(link.startsWith('ccswitch://v1/import?')).toBe(true);
    const params = new URLSearchParams(link.slice(link.indexOf('?') + 1));
    return { params, config: JSON.parse(Buffer.from(params.get('config')!, 'base64').toString('utf8')) };
  }

  it('carries the Dvalin server as Base64 `mcpServers` JSON, for the apps listed', () => {
    const { params, config } = decode(ccSwitchImportLink(['claude', 'codex'], '.'));

    expect(params.get('resource')).toBe('mcp');
    expect(params.get('apps')).toBe('claude,codex');
    expect(config).toEqual({ mcpServers: { dvalin: dvalinServerEntry('.') } });
  });

  /** CC Switch decodes an unescaped `+` as a space, which corrupts the Base64. */
  it('URL-encodes the Base64, so a `+` survives the trip', () => {
    // Any run of five `>` contains an aligned 0x3E3E3E, which is Base64 `Pj4+`.
    const link = ccSwitchImportLink(['claude'], '>>>>>');

    expect(link).toContain('%2B');
    expect(link.slice(link.indexOf('?'))).not.toContain('+');
    expect(decode(link).config).toEqual({ mcpServers: { dvalin: dvalinServerEntry('>>>>>') } });
  });

  it('names the server as asked, so it can sit beside an existing one', () => {
    expect(decode(ccSwitchImportLink(['gemini'], 'api', 'dvalin-api')).config)
      .toEqual({ mcpServers: { 'dvalin-api': dvalinServerEntry('api') } });
  });

  it("uses CC Switch's own app ids, and only for agents CC Switch syncs MCP into", () => {
    expect(CC_SWITCH_APPS).toEqual({ 'claude-code': 'claude', codex: 'codex', gemini: 'gemini', opencode: 'opencode' });
  });
});

describe('renderConfig', () => {
  it('writes indented JSON with a trailing newline, so the file diffs cleanly', () => {
    const rendered = renderConfig({ servers: { dvalin: { command: 'npx', args: [] } } });

    expect(rendered.endsWith('}\n')).toBe(true);
    expect(rendered).toContain('\n  "servers"');
  });
});

describe('the supported client list', () => {
  /**
   * Windsurf and Zed are absent on purpose: their formats could not be
   * confirmed from current documentation, and a config that is silently wrong
   * is worse than one that was never offered.
   */
  it('offers only editors whose format was verified', () => {
    expect(MCP_CLIENT_IDS).toEqual(['codex', 'cursor', 'vscode', 'claude-code', 'gemini', 'opencode']);
  });

  it('gives every client a name and every JSON client a project path', () => {
    for (const id of MCP_CLIENT_IDS) {
      const client = mcpClient(id);
      expect(client.name).toBeTruthy();
      if (client.id !== 'codex') expect(client.projectPath).toBeTruthy();
    }
  });
});
