import { describe, expect, it } from 'vitest';
import { classifyExit, commandToArgv, runScan, scanArgs } from '../src/scan.js';

describe('commandToArgv', () => {
  it('splits a multi-word command so `npx -y dvalincode` works', () => {
    expect(commandToArgv('npx -y dvalincode')).toEqual(['npx', '-y', 'dvalincode']);
  });

  it('tolerates padding and collapses repeated spaces', () => {
    expect(commandToArgv('  dvalincode  ')).toEqual(['dvalincode']);
  });

  it('yields nothing for an empty setting', () => {
    expect(commandToArgv('   ')).toEqual([]);
  });
});

describe('scanArgs', () => {
  it('asks for JSON and disables the gate, so findings arrive as data', () => {
    const args = scanArgs('builtin');
    expect(args).toContain('--json');
    expect(args.join(' ')).toContain('--fail-on none');
  });

  it('passes the configured scanners through', () => {
    expect(scanArgs('builtin,semgrep').join(' ')).toContain('--scanners builtin,semgrep');
  });

  it('narrows to uncommitted lines when the scope is `changed`', () => {
    const args = scanArgs('builtin', 'changed');
    expect(args).toContain('--diff');
    expect(args).not.toContain('uncommitted');
  });

  it('reads the whole workspace by default', () => {
    expect(scanArgs('builtin').join(' ')).not.toContain('--diff');
    expect(scanArgs('builtin', 'workspace').join(' ')).not.toContain('--diff');
  });
});

describe('classifyExit', () => {
  it('parses a successful scan', () => {
    const outcome = classifyExit(0, JSON.stringify({ score: 100, findings: [] }), '');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.score).toBe(100);
  });

  it('treats a non-zero exit as a CLI failure, not a result', () => {
    const outcome = classifyExit(2, '', "error: unknown option '--sarif'");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('failed');
      expect(outcome.message).toContain('unknown option');
    }
  });

  it('does not throw when stdout is not JSON', () => {
    const outcome = classifyExit(0, 'Dvalin security scan · /repo', '');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('not JSON');
  });

  it('falls back to stdout when the failure wrote nothing to stderr', () => {
    const outcome = classifyExit(1, 'something went wrong', '');
    if (!outcome.ok) expect(outcome.message).toContain('something went wrong');
  });
});

describe('runScan', () => {
  it('reports a missing CLI with a message that names the setting to change', async () => {
    const outcome = await runScan({
      command: 'dvalincode-definitely-not-installed',
      cwd: process.cwd(),
      scanners: 'builtin',
      timeoutMs: 5000,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('not-found');
      expect(outcome.message).toContain('dvalin.command');
    }
  });

  it('refuses an empty command instead of spawning a shell', async () => {
    const outcome = await runScan({ command: '  ', cwd: process.cwd(), scanners: 'builtin', timeoutMs: 1000 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('not-found');
  });
});
