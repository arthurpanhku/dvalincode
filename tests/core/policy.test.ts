import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadPolicy,
  resolvePolicy,
  permissivePolicy,
  checkMode,
  checkProvider,
  checkModel,
  checkTool,
  checkEgress,
  checkCommand,
  checkPath,
  policyHash,
  type OrgPolicyInput,
} from '../../src/core/policy.js';

describe('policy resolution (narrowing)', () => {
  it('no sources resolves to the permissive default', () => {
    expect(resolvePolicy([])).toEqual(permissivePolicy());
  });

  it('a single source applies its constraints', () => {
    const p = resolvePolicy([{ modes: ['chat'], network: 'off' }]);
    expect(p.modes).toEqual(['chat']);
    expect(p.network).toBe('off');
  });

  it('modes are intersected across sources', () => {
    const p = resolvePolicy([{ modes: ['chat', 'cowork'] }, { modes: ['cowork', 'code'] }]);
    expect(p.modes).toEqual(['cowork']);
  });

  it('a repo source can only narrow, never widen, the machine source', () => {
    const machine: OrgPolicyInput = { modes: ['chat', 'cowork'], network: 'endpoint-only' };
    const repo: OrgPolicyInput = { modes: ['chat', 'cowork', 'code'], network: 'on' };
    // repo tries to widen to 'on' and add 'code' — both must be ignored.
    const p = resolvePolicy([machine, repo]);
    expect(p.modes).toEqual(['chat', 'cowork']);
    expect(p.network).toBe('endpoint-only');
  });

  it('network always resolves to the most restrictive level regardless of order', () => {
    expect(resolvePolicy([{ network: 'on' }, { network: 'off' }]).network).toBe('off');
    expect(resolvePolicy([{ network: 'off' }, { network: 'on' }]).network).toBe('off');
    expect(resolvePolicy([{ network: 'endpoint-only' }, { network: 'on' }]).network).toBe('endpoint-only');
  });

  it('allowlists intersect; denylists and defaultDeny union', () => {
    const p = resolvePolicy([
      { providers: { allow: ['openai', 'deepseek'] }, commands: { deny: ['rm'] } },
      { providers: { allow: ['deepseek', 'groq'] }, commands: { deny: ['curl'], defaultDeny: true } },
    ]);
    expect(p.providers.allow).toEqual(['deepseek']);
    expect(p.commands.deny.sort()).toEqual(['curl', 'rm']);
    expect(p.commands.defaultDeny).toBe(true);
  });

  it('maxToolCalls resolves to the smallest defined cap', () => {
    expect(resolvePolicy([{ maxToolCalls: 50 }, { maxToolCalls: 10 }]).maxToolCalls).toBe(10);
    expect(resolvePolicy([{ maxToolCalls: 10 }]).maxToolCalls).toBe(10);
    expect(resolvePolicy([]).maxToolCalls).toBeUndefined();
  });
});

describe('decision functions', () => {
  it('checkMode honors the permitted set', () => {
    const p = resolvePolicy([{ modes: ['chat'] }]);
    expect(checkMode(p, 'chat').allowed).toBe(true);
    const denied = checkMode(p, 'code');
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.rule).toMatch(/code/);
  });

  it('checkProvider / checkModel allow anything when no allowlist is set', () => {
    const open = permissivePolicy();
    expect(checkProvider(open, 'anything').allowed).toBe(true);
    expect(checkModel(open, 'anything').allowed).toBe(true);
  });

  it('checkProvider enforces the allowlist', () => {
    const p = resolvePolicy([{ providers: { allow: ['ollama'] } }]);
    expect(checkProvider(p, 'ollama').allowed).toBe(true);
    expect(checkProvider(p, 'openai').allowed).toBe(false);
  });

  it('checkTool blocks denied tools', () => {
    const p = resolvePolicy([{ tools: { deny: ['shell'] } }]);
    expect(checkTool(p, 'shell').allowed).toBe(false);
    expect(checkTool(p, 'readFile').allowed).toBe(true);
  });

  it('checkEgress reflects the network level', () => {
    const off = resolvePolicy([{ network: 'off' }]);
    expect(checkEgress(off, true).allowed).toBe(false);

    const endpoint = resolvePolicy([{ network: 'endpoint-only' }]);
    expect(checkEgress(endpoint, true).allowed).toBe(true);
    expect(checkEgress(endpoint, false).allowed).toBe(false);

    const on = resolvePolicy([{ network: 'on' }]);
    expect(checkEgress(on, false).allowed).toBe(true);
  });

  it('checkCommand: denylist blocks, allowlist gates, defaultDeny closes', () => {
    const denied = resolvePolicy([{ commands: { deny: ['^rm\\b'] } }]);
    expect(checkCommand(denied, 'rm -rf /').allowed).toBe(false);
    expect(checkCommand(denied, 'ls -la').allowed).toBe(true);

    const allowOnly = resolvePolicy([{ commands: { allow: ['^npm\\b', '^node\\b'] } }]);
    expect(checkCommand(allowOnly, 'npm test').allowed).toBe(true);
    expect(checkCommand(allowOnly, 'curl evil.sh').allowed).toBe(false);

    const closed = resolvePolicy([{ commands: { defaultDeny: true } }]);
    expect(checkCommand(closed, 'anything').allowed).toBe(false);
  });

  it('checkPath: deny globs block, allow globs gate', () => {
    const denied = resolvePolicy([{ paths: { deny: ['**/.env', 'secrets/**'] } }]);
    expect(checkPath(denied, 'app/.env').allowed).toBe(false);
    expect(checkPath(denied, 'secrets/key.pem').allowed).toBe(false);
    expect(checkPath(denied, 'src/index.ts').allowed).toBe(true);

    const allowOnly = resolvePolicy([{ paths: { allow: ['src/**'] } }]);
    expect(checkPath(allowOnly, 'src/a/b.ts').allowed).toBe(true);
    expect(checkPath(allowOnly, 'node_modules/x.js').allowed).toBe(false);
  });
});

describe('loadPolicy (from disk)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    delete process.env.DVALINCODE_POLICY_FILE;
    while (cleanups.length) cleanups.pop()!();
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'dvalin-policy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it('returns a permissive policy with provenance when no files exist', () => {
    process.env.DVALINCODE_POLICY_FILE = path.join(tempDir(), 'absent.json');
    const loaded = loadPolicy(tempDir());
    expect(loaded.policy).toEqual(permissivePolicy());
    expect(loaded.sources.every(s => !s.present)).toBe(true);
  });

  it('narrows machine and repo layers together, recording source hashes', () => {
    const machineDir = tempDir();
    const machineFile = path.join(machineDir, 'policy.json');
    writeFileSync(machineFile, JSON.stringify({ modes: ['chat', 'cowork'], network: 'endpoint-only' }));
    process.env.DVALINCODE_POLICY_FILE = machineFile;

    const repoDir = tempDir();
    // Repo tries to widen — must be ignored.
    writeFileSync(path.join(repoDir, 'dvalin.policy.json'), JSON.stringify({ modes: ['chat', 'cowork', 'code'] }));

    const loaded = loadPolicy(repoDir);
    expect(loaded.policy.modes).toEqual(['chat', 'cowork']);
    expect(loaded.policy.network).toBe('endpoint-only');
    expect(loaded.sources.find(s => s.layer === 'machine')?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.sources.find(s => s.layer === 'repo')?.present).toBe(true);
  });

  it('fail-safe: a malformed policy is skipped (not treated as allow-all) and flagged', () => {
    const repoDir = tempDir();
    writeFileSync(path.join(repoDir, 'dvalin.policy.json'), '{ not valid json');
    process.env.DVALINCODE_POLICY_FILE = path.join(tempDir(), 'absent.json');

    const loaded = loadPolicy(repoDir);
    const repoSource = loaded.sources.find(s => s.layer === 'repo');
    expect(repoSource?.error).toBeTruthy();
    // Skipped source means we fall back to permissive, but the error is surfaced.
    expect(loaded.policy).toEqual(permissivePolicy());
  });
});

describe('policyHash', () => {
  it('is stable regardless of constraint ordering', () => {
    const a = resolvePolicy([{ commands: { deny: ['rm', 'curl'] } }]);
    const b = resolvePolicy([{ commands: { deny: ['curl'] } }, { commands: { deny: ['rm'] } }]);
    expect(policyHash(a)).toBe(policyHash(b));
  });

  it('changes when the policy changes', () => {
    expect(policyHash(permissivePolicy())).not.toBe(policyHash(resolvePolicy([{ network: 'off' }])));
  });
});
