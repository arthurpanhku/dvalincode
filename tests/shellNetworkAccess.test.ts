import { describe, expect, it } from 'vitest';
import { isGitNetworkCommand, shellTool } from '../src/tools/shell.js';

describe('shell network access escalation', () => {
  it('detects git commands that need outbound network access', () => {
    expect(isGitNetworkCommand('git', ['pull'])).toBe(true);
    expect(isGitNetworkCommand('git', ['push', 'origin', 'main'])).toBe(true);
    expect(isGitNetworkCommand('git', ['fetch', '--all'])).toBe(true);
    expect(isGitNetworkCommand('git', ['clone', 'https://github.com/example/repo.git'])).toBe(true);
    expect(isGitNetworkCommand('git', ['-C', '/repo', 'pull', '--ff-only'])).toBe(true);
    expect(isGitNetworkCommand('git', ['remote', 'update'])).toBe(true);
    expect(isGitNetworkCommand('git', ['submodule', 'update', '--init', '--recursive'])).toBe(true);
    expect(isGitNetworkCommand('git', ['lfs', 'pull'])).toBe(true);
  });

  it('leaves local git commands sandboxed by default', () => {
    expect(isGitNetworkCommand('git', ['status', '--porcelain'])).toBe(false);
    expect(isGitNetworkCommand('git', ['diff'])).toBe(false);
    expect(isGitNetworkCommand('git', ['log', '--oneline', '-5'])).toBe(false);
    expect(isGitNetworkCommand('npm', ['install'])).toBe(false);
  });

  it('defaults shell networkAccess to auto', () => {
    const parsed = shellTool.inputSchema.parse({ command: 'git', args: ['pull'] });
    expect(parsed.networkAccess).toBe('auto');
  });
});
