import { readFile, stat } from 'node:fs/promises';
import fg from 'fast-glob';
import { z } from 'zod';
import { gitRead } from '../core/gitRead.js';
import { resolveInsideWorkspace } from '../core/workspace.js';
import { loadIgnorePatterns } from '../core/ignorefile.js';
import type { Tool } from './types.js';

const DEFAULT_IGNORES = ['**/.git/**', '**/node_modules/**', '**/dist/**', '**/coverage/**'];
/** Larger files are generated, minified, or data, and are skipped. */
const MAX_FILE_BYTES = 2_000_000;
/** Matching lines are shown up to this many characters. */
const MAX_SHOWN_LINE_CHARS = 500;
/** A regex is tested against at most this much of each line. */
const MAX_REGEX_LINE_CHARS = 10_000;
const TIME_BUDGET_MS = 10_000;

const inputSchema = z
  .object({
    query: z.string().min(1).describe('Text to find. With regex set, a JavaScript regular expression.'),
    regex: z.boolean().default(false).describe('Treat query as a JavaScript regular expression, e.g. "export (async )?function \\w+".'),
    pattern: z.string().default('**/*').describe('Glob of files to search, e.g. "src/**/*.{ts,tsx}".'),
    caseSensitive: z.boolean().default(false),
    context: z.number().int().min(0).max(10).default(0).describe('Lines of context to show before and after each match.'),
    filesOnly: z.boolean().default(false).describe('List the files that match instead of the matching lines.'),
    limit: z.number().int().positive().max(500).default(50).describe('Maximum matching lines (or files, with filesOnly) to return.'),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const searchTextTool: Tool<Input> = {
  name: 'search_text',
  description:
    'Search text files in the workspace for a string or regular expression and return matching lines, optionally with surrounding context, or just the matching files. Skips files ignored by .gitignore and .dvalincodeignore.',
  access: 'read',
  inputSchema,
  isConcurrencySafe: () => true,
  async run(input, context) {
    const matches = buildMatcher(input);
    const started = Date.now();

    const userIgnore = await loadIgnorePatterns(context.cwd);
    const gitIgnored = await gitIgnoredPaths(context.cwd);
    const files = (
      await fg(input.pattern, {
        cwd: context.cwd,
        dot: true,
        onlyFiles: true,
        followSymbolicLinks: false,
        ignore: [...DEFAULT_IGNORES, ...userIgnore, ...(gitIgnored?.directories ?? [])],
      })
    )
      .filter(file => !gitIgnored?.files.has(file))
      .sort();

    const out: string[] = [];
    let found = 0;
    let filesMatched = 0;
    let skippedLarge = 0;
    let timedOut = false;

    for (const file of files) {
      if (found >= input.limit) break;
      if (Date.now() - started > TIME_BUDGET_MS) {
        timedOut = true;
        break;
      }
      const filePath = await resolveInsideWorkspace(context.cwd, file);
      const size = await fileSize(filePath);
      if (size === null) continue;
      if (size > MAX_FILE_BYTES) {
        skippedLarge++;
        continue;
      }
      const text = await readMaybeText(filePath);
      if (text === null) continue;

      const lines = text.split(/\r?\n/);
      const hits: number[] = [];
      for (let index = 0; index < lines.length && found + hits.length < input.limit; index++) {
        if (matches(lines[index])) {
          hits.push(index);
          if (input.filesOnly) break;
        }
      }
      if (hits.length === 0) continue;

      filesMatched++;
      found += hits.length;
      if (input.filesOnly) out.push(file);
      else out.push(...formatHits(file, lines, hits, input.context, out.length > 0));
    }

    const unit = input.filesOnly ? 'file' : 'match';
    const notes = [
      found >= input.limit ? `Stopped at the limit of ${input.limit}; narrow the query or pattern to see more.` : '',
      timedOut ? `Stopped after ${TIME_BUDGET_MS / 1000}s; narrow the pattern to search the rest.` : '',
      skippedLarge ? `Skipped ${skippedLarge} file(s) over ${MAX_FILE_BYTES / 1_000_000} MB.` : '',
    ].filter(Boolean);

    return {
      title: `Found ${found} ${unit}${found === 1 ? '' : unit === 'match' ? 'es' : 's'}`,
      output: [out.join('\n') || '(no matches)', ...notes].join('\n'),
      metadata: {
        scannedFiles: files.length,
        matchedFiles: filesMatched,
        limit: input.limit,
        gitignore: gitIgnored !== null,
        timedOut,
        skippedLargeFiles: skippedLarge,
      },
    };
  },
};

function buildMatcher(input: Input): (line: string) => boolean {
  if (!input.regex) {
    const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
    return line => (input.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  assertSafeRegex(input.query);
  let pattern: RegExp;
  try {
    pattern = new RegExp(input.query, input.caseSensitive ? '' : 'i');
  } catch (error) {
    throw new Error(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
  return line => pattern.test(line.length > MAX_REGEX_LINE_CHARS ? line.slice(0, MAX_REGEX_LINE_CHARS) : line);
}

/**
 * Refuse a regex with a repeated group that itself contains a repeat, such as
 * (a+)+ or (\w*){2,}. That shape can backtrack exponentially, and the search
 * runs inside the agent's process, so one bad pattern would freeze it. A
 * heuristic (the classic "star height" check), not a proof of safety.
 */
export function assertSafeRegex(source: string): void {
  const groupHasRepeat: boolean[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') {
      for (i++; i < source.length && source[i] !== ']'; i++) {
        if (source[i] === '\\') i++;
      }
      continue;
    }
    if (ch === '(') {
      groupHasRepeat.push(false);
      // Skip the group-kind marker: (?: (?= (?! (?<= (?<! (?<name>
      if (source[i + 1] === '?') {
        i += 2;
        if (source[i] === '<' && source[i + 1] !== '=' && source[i + 1] !== '!') {
          const close = source.indexOf('>', i);
          i = close === -1 ? source.length : close;
        } else if (source[i] === '<') {
          i++;
        }
      }
      continue;
    }
    if (ch === ')') {
      const inner = groupHasRepeat.pop() ?? false;
      if (inner && isRepeatAt(source, i + 1)) {
        throw new Error(
          'This regular expression repeats a group that already contains a repeat, such as (a+)+, which can take exponentially long. Rewrite it without nesting repeats.',
        );
      }
      if (inner && groupHasRepeat.length > 0) groupHasRepeat[groupHasRepeat.length - 1] = true;
      continue;
    }
    if (groupHasRepeat.length > 0 && isRepeatAt(source, i)) groupHasRepeat[groupHasRepeat.length - 1] = true;
  }
}

/** `*`, `+`, or a `{n}` / `{n,}` / `{n,m}` quantifier at `index`. */
function isRepeatAt(source: string, index: number): boolean {
  const ch = source[index];
  return ch === '*' || ch === '+' || (ch === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(index)));
}

/** Lines for one file's hits, grep style: `file:line: text` for matches, `file-line- text` for context. */
function formatHits(file: string, lines: string[], hits: number[], context: number, separate: boolean): string[] {
  const out: string[] = [];
  const hitSet = new Set(hits);
  let lastShown = -2;
  for (const hit of hits) {
    const from = Math.max(0, hit - context, lastShown + 1);
    const to = Math.min(lines.length - 1, hit + context);
    if (context > 0 && (separate || out.length > 0) && from > lastShown + 1) out.push('--');
    for (let index = from; index <= to; index++) {
      const marker = hitSet.has(index) ? ':' : '-';
      out.push(`${file}${marker}${index + 1}${marker} ${clip(lines[index])}`);
    }
    lastShown = to;
  }
  return out;
}

function clip(line: string): string {
  return line.length > MAX_SHOWN_LINE_CHARS ? `${line.slice(0, MAX_SHOWN_LINE_CHARS)}… [${line.length} chars]` : line;
}

/**
 * Paths .gitignore excludes, from git itself: whole directories (as fast-glob
 * ignore patterns, so they are never walked) and single files. Null outside a
 * git work tree or without git, in which case only the default ignores apply.
 */
async function gitIgnoredPaths(cwd: string): Promise<{ directories: string[]; files: Set<string> } | null> {
  try {
    const { stdout, truncated } = await gitRead(
      ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
      cwd,
      8 * 1024 * 1024,
    );
    if (truncated) return null;
    const directories: string[] = [];
    const files = new Set<string>();
    for (const entry of stdout.split('\0')) {
      // "./" means the workspace itself is ignored; searching it was asked for explicitly.
      if (!entry || entry === './') continue;
      if (entry.endsWith('/')) directories.push(`${fg.escapePath(entry)}**`);
      else files.add(entry);
    }
    return { directories, files };
  } catch {
    return null;
  }
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return null;
  }
}

async function readMaybeText(filePath: string): Promise<string | null> {
  try {
    const text = await readFile(filePath, 'utf8');
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}
