import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRunner } from '../src/agent/runner.js';
import { gitContextLine } from '../src/agent/session.js';
import { gitDiffTool } from '../src/tools/gitDiff.js';
import { gitStatusTool } from '../src/tools/gitStatus.js';
import { createDvalinContext, type DvalinContextOptions } from '../src/core/context.js';
import type { ChatMessage, ProviderAdapter } from '../src/providers/types.js';
import { editFileTool } from '../src/tools/editFile.js';
import { gitBlameTool } from '../src/tools/gitBlame.js';
import { gitLogTool } from '../src/tools/gitLog.js';
import { gitShowTool } from '../src/tools/gitShow.js';
import { readFileTool } from '../src/tools/readFile.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { assertSafeRegex, searchTextTool } from '../src/tools/searchText.js';
import { carryChecklist, latestChecklist, updatePlanTool } from '../src/tools/updatePlan.js';
import { writeFileTool } from '../src/tools/writeFile.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function put(root: string, relative: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content, 'utf8');
}

/** git with no user/system config, so the developer's own settings cannot leak in. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(cwd, '.no-global-gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
    },
  });
}

function context(cwd: string, options: DvalinContextOptions = {}) {
  return createDvalinContext({ cwd, approvalMode: 'full-auto', ...options });
}

/** A provider that replies with each scripted message in turn. */
function scripted(replies: string[]): ProviderAdapter {
  let index = 0;
  return { name: 'scripted', chat: async () => ({ content: replies[Math.min(index++, replies.length - 1)], model: 'scripted' }) };
}

describe('search_text', () => {
  let repo: string;

  beforeAll(() => {
    repo = tempDir('dvalin-search-');
    git(repo, 'init', '-q');
    put(repo, '.gitignore', 'ignored/\n*.log\n');
    put(repo, 'src/a.ts', 'import x from "x";\nexport function alpha() {}\nconst needle = 1;\nexport async function beta() {}\n');
    put(repo, 'src/b.tsx', 'export const Gamma = () => null; // needle\n');
    put(repo, 'notes.md', `needle in notes\n${'z'.repeat(2_000)}needle\n`);
    put(repo, 'ignored/x.ts', 'needle in an ignored directory\n');
    put(repo, 'debug.log', 'needle in an ignored file\n');
  });

  it('matches a regular expression across files', async () => {
    const result = await searchTextTool.run(
      searchTextTool.inputSchema.parse({ query: 'export (async )?function \\w+', regex: true }),
      context(repo),
    );
    expect(result.output.split('\n')).toEqual([
      'src/a.ts:2: export function alpha() {}',
      'src/a.ts:4: export async function beta() {}',
    ]);
  });

  it('skips paths .gitignore excludes and still understands brace globs', async () => {
    const all = await searchTextTool.run(searchTextTool.inputSchema.parse({ query: 'needle', filesOnly: true }), context(repo));
    expect(all.output.split('\n')).toEqual(['notes.md', 'src/a.ts', 'src/b.tsx']);
    expect(all.metadata?.gitignore).toBe(true);

    const braces = await searchTextTool.run(
      searchTextTool.inputSchema.parse({ query: 'needle', pattern: 'src/**/*.{ts,tsx}', filesOnly: true }),
      context(repo),
    );
    expect(braces.output.split('\n')).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('shows context lines grep-style and clips very long lines', async () => {
    const withContext = await searchTextTool.run(
      searchTextTool.inputSchema.parse({ query: 'const needle', context: 1, pattern: 'src/**' }),
      context(repo),
    );
    expect(withContext.output.split('\n')).toEqual([
      'src/a.ts-2- export function alpha() {}',
      'src/a.ts:3: const needle = 1;',
      'src/a.ts-4- export async function beta() {}',
    ]);

    const long = await searchTextTool.run(searchTextTool.inputSchema.parse({ query: 'zneedle', pattern: 'notes.md' }), context(repo));
    expect(long.output).toContain('… [2006 chars]');
  });

  it('refuses regexes that nest repeats, and reports invalid ones', async () => {
    for (const unsafe of ['(a+)+$', '(\\w*)*', '(\\d+){4}', '((ab)+c)*']) {
      expect(() => assertSafeRegex(unsafe), unsafe).toThrow(/repeats a group/);
    }
    for (const safe of ['(?:foo)+', '(?<year>\\d+)-x', '[a+]+', '(ab|cd)*', 'export (async )?function \\w+', '\\(a+\\)+']) {
      expect(() => assertSafeRegex(safe), safe).not.toThrow();
    }
    await expect(
      searchTextTool.run(searchTextTool.inputSchema.parse({ query: '(unclosed', regex: true }), context(repo)),
    ).rejects.toThrow(/Invalid regular expression/);
  });

  it('works outside a git repository with the default ignores', async () => {
    const plain = tempDir('dvalin-search-plain-');
    put(plain, 'a.txt', 'needle\n');
    put(plain, 'node_modules/pkg/index.js', 'needle\n');
    const result = await searchTextTool.run(searchTextTool.inputSchema.parse({ query: 'needle', filesOnly: true }), context(plain));
    expect(result.output).toBe('a.txt');
    expect(result.metadata?.gitignore).toBe(false);
  });
});

describe('edit_file', () => {
  let dir: string;

  beforeAll(() => {
    dir = tempDir('dvalin-edit-');
  });

  it('applies several edits in order with one write', async () => {
    put(dir, 'multi.ts', 'const a = 1;\nconst b = 2;\n');
    const input = editFileTool.inputSchema.parse({
      filePath: 'multi.ts',
      edits: [
        { oldString: 'const a = 1;', newString: 'const a = 10;' },
        { oldString: 'const a = 10;\nconst b = 2;', newString: 'const a = 10;\nconst b = 20;' },
      ],
    });
    const result = await editFileTool.run(input, context(dir));
    expect(readFileSync(path.join(dir, 'multi.ts'), 'utf8')).toBe('const a = 10;\nconst b = 20;\n');
    expect(result.output).toMatch(/^Applied 2 edits \(2 replacements\)/);
  });

  it('writes nothing when any edit in the batch fails', async () => {
    put(dir, 'atomic.ts', 'one\ntwo\n');
    const input = editFileTool.inputSchema.parse({
      filePath: 'atomic.ts',
      edits: [
        { oldString: 'one', newString: 'ONE' },
        { oldString: 'missing', newString: 'x' },
      ],
    });
    await expect(editFileTool.run(input, context(dir))).rejects.toThrow('Edit 2 of 2: Could not find oldString');
    expect(readFileSync(path.join(dir, 'atomic.ts'), 'utf8')).toBe('one\ntwo\n');
  });

  it('replaces every occurrence with replaceAll and suggests it when a string is ambiguous', async () => {
    put(dir, 'rename.ts', 'let count = 0;\ncount += 1;\nreturn count;\n');
    await expect(
      editFileTool.run(editFileTool.inputSchema.parse({ filePath: 'rename.ts', oldString: 'count', newString: 'total' }), context(dir)),
    ).rejects.toThrow(/matches 3 places.*replaceAll/);

    const result = await editFileTool.run(
      editFileTool.inputSchema.parse({ filePath: 'rename.ts', oldString: 'count', newString: 'total', replaceAll: true }),
      context(dir),
    );
    expect(readFileSync(path.join(dir, 'rename.ts'), 'utf8')).toBe('let total = 0;\ntotal += 1;\nreturn total;\n');
    expect(result.output).toMatch(/^Replaced 3 occurrences of "count"/);
    expect(result.metadata?.occurrences).toBe(3);
  });

  it('accepts exactly one of edits or oldString/newString', () => {
    expect(editFileTool.inputSchema.safeParse({ filePath: 'x', oldString: 'a', newString: 'b' }).success).toBe(true);
    expect(editFileTool.inputSchema.safeParse({ filePath: 'x', edits: [{ oldString: 'a', newString: 'b' }] }).success).toBe(true);
    expect(
      editFileTool.inputSchema.safeParse({ filePath: 'x', oldString: 'a', newString: 'b', edits: [{ oldString: 'a', newString: 'b' }] })
        .success,
    ).toBe(false);
    expect(editFileTool.inputSchema.safeParse({ filePath: 'x', oldString: 'a' }).success).toBe(false);
  });

  it('undoes a batch or replaceAll edit by restoring the original file', async () => {
    const original = 'x = 1\nx = 2\ny = 3\n';
    put(dir, 'undo.py', original);
    const input = editFileTool.inputSchema.parse({ filePath: 'undo.py', oldString: 'x', newString: 'y', replaceAll: true });
    const result = await editFileTool.run(input, context(dir));

    const reverse = editFileTool.reverse!(input, result)!;
    expect(reverse.toolName).toBe('write_file');
    await writeFileTool.run(reverse.input as { filePath: string; content: string }, context(dir));
    // Swapping y back to x would also have rewritten the "y = 3" that was there before.
    expect(readFileSync(path.join(dir, 'undo.py'), 'utf8')).toBe(original);
  });
});

describe('read_file on large files', () => {
  let dir: string;
  let content: string;

  beforeAll(() => {
    dir = tempDir('dvalin-read-');
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`);
    lines[149] = 'q'.repeat(5_000);
    content = lines.join('\r\n') + '\r\n';
    put(dir, 'big.log', content);
  });

  it('reads a line range of a file over the size limit and hashes the whole file', async () => {
    const result = await readFileTool.run({ filePath: 'big.log', offset: 10, limit: 3 }, context(dir, { maxBytes: 1_000 }));
    expect(result.output.split('\n')).toEqual(['  11 | line 11', '  12 | line 12', '  13 | line 13']);
    expect(result.metadata).toMatchObject({
      totalLines: 301,
      offset: 10,
      returnedLines: 3,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  });

  it('cuts very long lines and still refuses a whole read', async () => {
    const result = await readFileTool.run({ filePath: 'big.log', offset: 149, limit: 1 }, context(dir, { maxBytes: 1_000 }));
    expect(result.output).toMatch(/^ 150 \| q{2000}… \[line is 5000 characters\]$/);
    await expect(readFileTool.run({ filePath: 'big.log' }, context(dir, { maxBytes: 1_000 }))).rejects.toThrow(
      /read it in parts with offset and limit/,
    );
  });
});

describe('update_plan', () => {
  const planCall = (plan: Array<{ step: string; status: string }>) => `@tool("update_plan", ${JSON.stringify({ plan })})`;

  it('allows one step in progress and reports progress', async () => {
    expect(
      updatePlanTool.inputSchema.safeParse({
        plan: [
          { step: 'a', status: 'in_progress' },
          { step: 'b', status: 'in_progress' },
        ],
      }).success,
    ).toBe(false);
    const result = await updatePlanTool.run(
      updatePlanTool.inputSchema.parse({
        plan: [
          { step: 'Read the code', status: 'completed' },
          { step: 'Fix the bug', status: 'in_progress' },
          { step: 'Run tests', status: 'pending' },
        ],
      }),
      context(process.cwd()),
    );
    expect(result.output).toBe('Checklist updated: 1 of 3 steps done. In progress: Fix the bug');
  });

  it('carries the latest checklist through compaction', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '1', name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Old', status: 'pending' }] }) }],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: '2',
            name: 'update_plan',
            arguments: JSON.stringify({ plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'in_progress' }] }),
          },
        ],
      },
    ];
    expect(latestChecklist(messages)?.map(s => s.step)).toEqual(['Read', 'Write']);
    expect(carryChecklist('Summary.', messages)).toBe(
      'Summary.\n\nTask checklist when the conversation was compacted (keep it current with update_plan):\n- [x] Read\n- [~] Write',
    );
    // Nothing to add when the kept messages already hold the checklist.
    expect(carryChecklist('Summary.', messages, messages.slice(2))).toBe('Summary.');
  });

  it('sends the model back when it stops with open steps, but not in read-only modes', async () => {
    const replies = [
      planCall([
        { step: 'Edit', status: 'completed' },
        { step: 'Test', status: 'in_progress' },
      ]),
      'All done.',
      planCall([
        { step: 'Edit', status: 'completed' },
        { step: 'Test', status: 'completed' },
      ]),
      'Finished.',
    ];
    const run = (approvalMode: 'full-auto' | 'readonly') => {
      const registry = new ToolRegistry();
      registry.register(updatePlanTool);
      return new AgentRunner({
        provider: scripted(replies),
        registry,
        context: createDvalinContext({ approvalMode }),
        config: { maxIterations: 10, maxToolCallsPerTurn: 100, contextTokenLimit: 128_000, compactThreshold: 0.7 },
        systemPrompt: 'Work.',
      }).runTurn('go', []);
    };

    const acting = await run('full-auto');
    expect(acting.finalResponse).toBe('Finished.');
    expect(acting.messages.some(m => m.role === 'user' && m.content.includes('your checklist still has 1 unfinished step'))).toBe(
      true,
    );

    const planning = await run('readonly');
    expect(planning.finalResponse).toBe('All done.');
  });

  it('stops nudging after two checks per turn', async () => {
    const registry = new ToolRegistry();
    registry.register(updatePlanTool);
    const result = await new AgentRunner({
      provider: scripted([planCall([{ step: 'Never done', status: 'pending' }]), 'Done.']),
      registry,
      context: createDvalinContext({ approvalMode: 'full-auto' }),
      config: { maxIterations: 10, maxToolCallsPerTurn: 100, contextTokenLimit: 128_000, compactThreshold: 0.7 },
      systemPrompt: 'Work.',
    }).runTurn('go', []);
    expect(result.finalResponse).toBe('Done.');
    expect(result.stopReason).toBe('done');
    expect(result.messages.filter(m => m.role === 'user' && m.content.includes('your checklist still has')).length).toBe(2);
  });
});

describe('git history tools', () => {
  let repo: string;

  beforeAll(() => {
    repo = tempDir('dvalin-git-');
    git(repo, 'init', '-q');
    put(repo, 'src/app.ts', 'line one\nline two\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'feat: add app');
    put(repo, 'src/app.ts', 'line one\nline 2\n');
    put(repo, '.env', 'SECRET=hunter2\n');
    put(repo, '.dvalincodeignore', '.env\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'fix: tweak app');
  });

  it('git_log lists commits, filtered by path, message, or starting point', async () => {
    const all = await gitLogTool.run(gitLogTool.inputSchema.parse({}), context(repo));
    expect(all.output.split('\n').map(line => line.split('  ').at(-1))).toEqual(['fix: tweak app', 'feat: add app']);

    const byMessage = await gitLogTool.run(gitLogTool.inputSchema.parse({ grep: 'FIX' }), context(repo));
    expect(byMessage.output).toContain('fix: tweak app');
    expect(byMessage.output).not.toContain('feat: add app');

    const older = await gitLogTool.run(gitLogTool.inputSchema.parse({ ref: 'HEAD~1', filePath: 'src/app.ts' }), context(repo));
    expect(older.metadata?.commits).toBe(1);
  });

  it('git_show shows a commit but leaves .dvalincodeignore paths out', async () => {
    const shown = await gitShowTool.run(gitShowTool.inputSchema.parse({}), context(repo));
    expect(shown.output).toContain('fix: tweak app');
    expect(shown.output).toContain('+line 2');
    expect(shown.output).not.toContain('hunter2');

    const stat = await gitShowTool.run(gitShowTool.inputSchema.parse({ statOnly: true }), context(repo));
    expect(stat.output).toMatch(/src\/app\.ts\s+\| 2 \+-/);
    expect(stat.output).not.toContain('.env');
  });

  it('git_blame attributes each line and refuses ignored files', async () => {
    const blame = await gitBlameTool.run(gitBlameTool.inputSchema.parse({ filePath: 'src/app.ts' }), context(repo));
    const lines = blame.output.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/\(Test Author \d{4}-\d{2}-\d{2} 2\) line 2$/);

    const one = await gitBlameTool.run(gitBlameTool.inputSchema.parse({ filePath: 'src/app.ts', startLine: 2, endLine: 2 }), context(repo));
    expect(one.output.split('\n')).toHaveLength(1);

    await expect(gitBlameTool.run(gitBlameTool.inputSchema.parse({ filePath: '.env' }), context(repo))).rejects.toThrow(
      /excluded by \.dvalincodeignore/,
    );
  });

  it('refuses revisions that could act as options or print a file past the ignore rules', async () => {
    const marker = path.join(repo, 'written-by-git');
    await expect(
      gitLogTool.run(gitLogTool.inputSchema.parse({ ref: `--output=${marker}` }), context(repo)),
    ).rejects.toThrow(/Not a usable revision/);
    await expect(gitShowTool.run(gitShowTool.inputSchema.parse({ ref: 'HEAD:.env' }), context(repo))).rejects.toThrow(
      /Not a usable revision/,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('git_diff leaves .dvalincodeignore paths out too', async () => {
    put(repo, '.env', 'SECRET=changed-secret\n');
    put(repo, 'src/app.ts', 'line one\nline 2\nline three\n');
    const diff = await gitDiffTool.run(gitDiffTool.inputSchema.parse({}), context(repo));
    expect(diff.output).toContain('+line three');
    expect(diff.output).not.toContain('changed-secret');

    const direct = await gitDiffTool.run(gitDiffTool.inputSchema.parse({ filePath: '.env' }), context(repo));
    expect(direct.output).toMatch(/excluded by \.dvalincodeignore/);
  });

  it.skipIf(process.platform === 'win32')('never runs programs named in the repository git config', async () => {
    const hostile = tempDir('dvalin-git-hostile-');
    const marker = path.join(hostile, 'hook-ran');
    const hook = path.join(hostile, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`);
    chmodSync(hook, 0o755);
    git(hostile, 'init', '-q');
    put(hostile, '.gitattributes', '*.txt diff=evil\n');
    put(hostile, 'a.txt', 'a\n');
    git(hostile, 'add', '-A');
    git(hostile, 'commit', '-qm', 'one');
    put(hostile, 'a.txt', 'a\nb\n');
    git(hostile, 'commit', '-qam', 'two');
    git(hostile, 'config', 'core.fsmonitor', hook);
    git(hostile, 'config', 'diff.evil.textconv', hook);

    put(hostile, 'a.txt', 'a\nb\nc\n');

    // Controls: plain git runs the hook (textconv for show, fsmonitor for
    // status), so the checks below mean something.
    for (const plain of [['show', 'HEAD'], ['status', '--porcelain']]) {
      git(hostile, ...plain);
      expect(existsSync(marker), plain.join(' ')).toBe(true);
      rmSync(marker);
    }

    await gitShowTool.run(gitShowTool.inputSchema.parse({}), context(hostile));
    await gitLogTool.run(gitLogTool.inputSchema.parse({ filePath: 'a.txt' }), context(hostile));
    await gitBlameTool.run(gitBlameTool.inputSchema.parse({ filePath: 'a.txt' }), context(hostile));
    await searchTextTool.run(searchTextTool.inputSchema.parse({ query: 'b' }), context(hostile));
    await gitStatusTool.run({}, context(hostile));
    const diff = await gitDiffTool.run(gitDiffTool.inputSchema.parse({}), context(hostile));
    expect(diff.output).toContain('+c');
    expect(await gitContextLine(hostile)).toContain('1 changed file');
    expect(existsSync(marker)).toBe(false);
  });
});
