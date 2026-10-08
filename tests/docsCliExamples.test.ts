import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDvalinProgram } from '../src/dvalinCli.js';
import { buildProgram } from '../src/cli.js';

/**
 * Commands in the docs are run by people who copy them. Two binaries ship —
 * `dvalin` (security subcommands) and `dvalincode` (everything, including the
 * `dvalin` fix pipeline) — and a doc once told readers to run
 * `dvalin . --until-clean`, which `dvalin` rejects. These check every `dvalin`
 * invocation in the docs' code against the real command tree.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    return statSync(full).isDirectory() ? files(full, pattern) : pattern.test(name) ? [full] : [];
  });
}

/** Code the reader would paste: fenced blocks and inline spans in Markdown, everything in YAML. */
function codeOf(file: string): string[] {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  if (!file.endsWith('.md')) return text.split('\n');
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap(match => match[1]!.split('\n'));
  const inline = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(match => match[1]!);
  return [...fenced, ...inline];
}

const sources = [
  path.join(repoRoot, 'README.md'),
  path.join(repoRoot, 'README.zh-CN.md'),
  path.join(repoRoot, 'action.yml'),
  ...files(path.join(repoRoot, 'docs'), /\.(?:md|ya?ml)$/),
  ...files(path.join(repoRoot, 'integrations'), /\.md$/),
];

describe('CLI commands quoted in the docs', () => {
  it('only use subcommands the dvalin binary has', () => {
    const known = new Set([...buildDvalinProgram().commands.map(command => command.name()), 'help', '--help', '--version', '-V', '-h']);
    const bad: string[] = [];
    for (const file of sources) {
      for (const line of codeOf(file)) {
        // `mcp add dvalin -- …` names an MCP server, not the binary.
        for (const match of line.matchAll(/(?<!dvalincode\s)(?<!mcp add\s)(?<![\w./@-])dvalin\s+([.\w-]+)/g)) {
          if (!known.has(match[1]!)) bad.push(`${path.relative(repoRoot, file)}: ${line.trim()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('only pass flags the dvalincode dvalin pipeline accepts', () => {
    const pipeline = buildProgram().commands.find(command => command.name() === 'dvalin')!;
    const flags = new Set(pipeline.options.flatMap(option => [option.long, option.short]).filter(Boolean) as string[]);
    const bad: string[] = [];
    for (const file of sources) {
      for (const line of codeOf(file)) {
        const at = line.search(/dvalincode\s+dvalin\b/);
        if (at < 0) continue;
        for (const flag of line.slice(at).match(/--[\w-]+/g) ?? []) {
          if (!flags.has(flag)) bad.push(`${path.relative(repoRoot, file)}: ${flag} in ${line.trim()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
