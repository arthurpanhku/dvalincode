import { describe, expect, it } from 'vitest';
import { validateGitBranchName, validateGitCloneUrl } from '../src/server/routes/projects.js';

describe('project route input hardening', () => {
  it('accepts common Git clone URL forms', () => {
    expect(validateGitCloneUrl('https://github.com/arthurpanhku/dvalincode.git')).toBe('https://github.com/arthurpanhku/dvalincode.git');
    expect(validateGitCloneUrl('git@github.com:arthurpanhku/dvalincode.git')).toBe('git@github.com:arthurpanhku/dvalincode.git');
    expect(validateGitCloneUrl('ssh://git@github.com/arthurpanhku/dvalincode.git')).toBe('ssh://git@github.com/arthurpanhku/dvalincode.git');
  });

  it('rejects clone URLs that Git could parse as options or local paths', () => {
    expect(() => validateGitCloneUrl('--upload-pack=/tmp/pwn')).toThrow('Invalid Git URL');
    expect(() => validateGitCloneUrl('/tmp/repo.git')).toThrow('Git URL must be http');
    expect(() => validateGitCloneUrl('file:///tmp/repo.git')).toThrow('Unsupported Git URL protocol');
  });

  it('accepts conservative branch names and rejects option-like names', () => {
    expect(validateGitBranchName('feature/security-hardening')).toBe('feature/security-hardening');
    expect(() => validateGitBranchName('--force')).toThrow('Invalid Git branch name');
    expect(() => validateGitBranchName('feature/../main')).toThrow('Invalid Git branch name');
    expect(() => validateGitBranchName('feature.lock')).toThrow('Invalid Git branch name');
  });
});
