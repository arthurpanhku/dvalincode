import { describe, expect, it } from 'vitest';
import {
  MCP_CLIENT_IDS,
  dvalinServerEntry,
  mcpClient,
  mergeDvalinServer,
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

  it('writes each editor to the path that editor actually reads', () => {
    expect(mcpClient('cursor').projectPath).toBe('.cursor/mcp.json');
    expect(mcpClient('vscode').projectPath).toBe('.vscode/mcp.json');
    expect(mcpClient('claude-code').projectPath).toBe('.mcp.json');
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

    expect(target.file).toBe('/repo/.cursor/mcp.json');
  });

  it('puts the global config in the home directory, not the project', () => {
    const target = resolveInstallTarget('cursor', '/repo', true);

    expect(target.file).not.toContain('/repo');
    expect(target.file.endsWith('/.cursor/mcp.json')).toBe(true);
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
    expect(MCP_CLIENT_IDS).toEqual(['cursor', 'vscode', 'claude-code']);
  });

  it('gives every client a name and a project path', () => {
    for (const id of MCP_CLIENT_IDS) {
      expect(mcpClient(id).name).toBeTruthy();
      expect(mcpClient(id).projectPath).toBeTruthy();
    }
  });
});
