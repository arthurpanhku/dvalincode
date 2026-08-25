import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../src/cli.js';

/**
 * The GitHub Action drives the CLI through a shell script embedded in YAML, so
 * nothing typechecks the command names it uses. A wrong subcommand path was
 * shipped once and only surfaced by running the action: the scan looked fine
 * and the fix-record step failed with `unknown option '--json'`.
 *
 * These assert that every CLI path action.yml invokes actually exists.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const actionYaml = readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');

function resolvePath(program: Command, names: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const name of names) {
    current = current?.commands.find(command => command.name() === name);
    if (!current) return undefined;
  }
  return current;
}

function optionNames(command: Command): string[] {
  return command.options.flatMap(option => [option.long, option.short].filter(Boolean) as string[]);
}

describe('the CLI contract action.yml depends on', () => {
  it('invokes command paths that exist on the dvalincode binary', () => {
    const program = buildProgram();

    // The action always builds `cli=(node dist/index.js)` or
    // `cli=(npx dvalincode@version)`, so every invocation is on this binary.
    for (const names of [['dvalin'], ['security', 'verify-fix']]) {
      expect(resolvePath(program, names), `action.yml calls "${names.join(' ')}"`).toBeDefined();
    }
  });

  it('passes only flags those commands accept', () => {
    const program = buildProgram();

    const scan = resolvePath(program, ['dvalin'])!;
    for (const flag of ['--scanners', '--timeout', '--fail-on', '--sarif', '--diff', '--json']) {
      expect(optionNames(scan), `dvalin accepts ${flag}`).toContain(flag);
    }

    const verifyFix = resolvePath(program, ['security', 'verify-fix'])!;
    expect(optionNames(verifyFix)).toContain('--json');
  });

  it('still spells those invocations the same way in action.yml', () => {
    // Guards the other direction: renaming a command here without updating the
    // action would leave these assertions passing against a stale expectation.
    expect(actionYaml).toContain('"${cli[@]}" dvalin "${DVALIN_PATH}"');
    expect(actionYaml).toContain('"${cli[@]}" security verify-fix "${DVALIN_FIX_RECORD}" --json');
  });

  it('declares every output the steps actually write', () => {
    // GITHUB_OUTPUT keys set by the scan step, and the `outputs:` block that
    // exposes them. A key written but never declared is invisible to callers.
    for (const key of ['score', 'grade', 'findings', 'coverage', 'fix-record-verified', 'fix-record-hash']) {
      expect(actionYaml, `output "${key}" is declared`).toContain(`  ${key}:\n    description:`);
      expect(actionYaml, `output "${key}" is wired to the scan step`).toContain(`steps.scan.outputs.${key} }}`);
    }
  });
});
