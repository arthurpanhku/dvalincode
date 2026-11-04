import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function json(relative: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'));
}

describe('the portable Codex plugin package', () => {
  const plugin = json('integrations/dvalin-security/plugin.json');
  const compatibility = json('integrations/dvalin-security/.codex-plugin/plugin.json');
  const packageJson = json('package.json');

  it('keeps portable and compatibility identities aligned with the release', () => {
    expect(plugin.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(plugin.name).toBe('dvalin-security');
    expect(plugin.version).toBe(packageJson.version);
    expect(compatibility.version).toBe(packageJson.version);
    expect(plugin.extensions['com.openai'].requires_local_executor).toBe(true);
  });

  it('does not bind a portable plugin server to the plugin cache instead of the project', () => {
    expect(existsSync(path.join(root, 'integrations/dvalin-security/mcp.json'))).toBe(false);
    expect(compatibility.mcpServers).toBeUndefined();
    expect(json('integrations/dvalin-security/.mcp.json').mcpServers.dvalin).toBeTruthy();
  });

  it('is discoverable from the repository marketplace', () => {
    const marketplace = json('.agents/plugins/marketplace.json');
    const entry = marketplace.plugins.find((candidate: any) => candidate.name === plugin.name);

    expect(entry).toBeTruthy();
    expect(entry.policy.installation).toBe('AVAILABLE');
    expect(existsSync(path.resolve(root, entry.source.path))).toBe(true);
  });
});
